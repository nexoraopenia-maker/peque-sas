import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { BillingError, closeCashSession, getOpenSession, openCashSession, payReservation } from "@/lib/billing/service";
import { cancelReservation, completeReservation, confirmReservation, createReservation, markNoShow, remaining } from "@/lib/reservations/service";
import { addDays } from "@/lib/reservations/calendar";
import { limaDate } from "@/lib/utils/date";

// Contra Turso remoto (RUN_REMOTE_TESTS=1). Datos con prefijo único, borrados al terminar.
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__resv_${Date.now()}`;
let planId = "", A = "", B = "", uA = "", uB = "", spaceA = "", spaceB = "";
const day = addDays(limaDate(), 10);   // fecha futura: no depende de la hora actual
const day2 = addDays(limaDate(), 11);
const cash = { first: "EFECTIVO" as const, firstAmountCents: null };
const key = () => `${tag}-${Math.random().toString(36).slice(2)}`;
const base = (over: Partial<Parameters<typeof createReservation>[0]> = {}) => ({
  tenantId: A, userId: uA, serviceType: "LUDOTECA" as const, contactName: "Contacto", date: day, startTime: "10:00", endTime: "12:00",
  attendees: 5, totalAmountCents: 10000, advanceRequiredCents: 3000, ...over,
});
const fail = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

run("Fase 9: reservas y calendario (Turso remoto)", () => {
  beforeAll(async () => {
    planId = (await db.plan.create({ data: { name: tag, modules: [] } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: ["WHATSAPP"], playgroundCapacity: 10, daycareCapacity: 4 } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: ["WHATSAPP"], playgroundCapacity: 10 } })).id;
    uA = (await db.user.create({ data: { email: `${tag}-a@example.test`, name: "a", role: "RECEPTION", tenantId: A, passwordHash: "x" } })).id;
    uB = (await db.user.create({ data: { email: `${tag}-b@example.test`, name: "b", role: "RECEPTION", tenantId: B, passwordHash: "x" } })).id;
    spaceA = (await db.reservationSpace.create({ data: { tenantId: A, name: "Sala 1", capacity: 20 } })).id;
    spaceB = (await db.reservationSpace.create({ data: { tenantId: B, name: "Sala B", capacity: 20 } })).id;
  }, 90000);

  afterAll(async () => {
    const w = { where: { tenantId: { in: [A, B] } } };
    await db.saleItem.deleteMany(w); await db.sale.deleteMany(w); await db.reservationChecklistItem.deleteMany(w);
    await db.reservation.deleteMany(w); await db.scheduleBlock.deleteMany(w); await db.reservationSpace.deleteMany(w);
    await db.cashRegisterSession.deleteMany(w); await db.child.deleteMany(w); await db.user.deleteMany(w);
    await db.tenant.deleteMany({ where: { id: { in: [A, B] } } }); await db.plan.deleteMany({ where: { id: planId } });
  }, 120000);

  it("validaciones de entrada", async () => {
    await fail(createReservation(base({ date: addDays(limaDate(), -1) })), /pasada/);
    await fail(createReservation(base({ startTime: "12:00", endTime: "10:00" })), /posterior/);
    await fail(createReservation(base({ startTime: "25:00" })), /inválidas/);
    await fail(createReservation(base({ attendees: 0 })), /asistentes/);
    await fail(createReservation(base({ advanceRequiredCents: 99999 })), /no puede superar/);
    await fail(createReservation(base({ contactName: "  " })), /contacto/);
    await fail(createReservation(base({ childId: "ajeno" })), /Menor no válido/);
    await fail(createReservation(base({ serviceType: "CUMPLEANOS" })), /espacio/);
    await fail(createReservation(base({ serviceType: "CUMPLEANOS", spaceId: spaceB })), /espacio/); // espacio de OTRO tenant
    await fail(createReservation(base({ serviceType: "EVENTO", spaceId: spaceA, attendees: 25 })), /hasta 20/);
    expect(await db.reservation.count({ where: { tenantId: A } })).toBe(0);
  }, 90000);

  it("aforo: reservas hasta el límite y rechazo al superarlo (franjas solapadas)", async () => {
    await createReservation(base({ attendees: 6 }));                       // 6/10
    await createReservation(base({ attendees: 4, startTime: "11:00", endTime: "13:00" })); // solapa: 10/10
    await fail(createReservation(base({ attendees: 1, startTime: "11:30", endTime: "12:30" })), /Sin cupo suficiente: quedan 0 de 10/);
    // tocarse en el extremo NO solapa: 12:00-13:00 solo solapa con la segunda (4)
    await expect(createReservation(base({ attendees: 6, startTime: "13:00", endTime: "14:00" }))).resolves.toBeTruthy();
    expect(await remaining(A, "LUDOTECA", day, "10:00", "11:00")).toBe(4);
  }, 120000);

  it("aforo atómico: 12 reservas simultáneas de 1 persona con 2 cupos libres → exactamente 2", async () => {
    // franja libre 16:00-17:00; capacidad 10 → llenamos 8 y quedan 2
    await createReservation(base({ attendees: 8, startTime: "16:00", endTime: "17:00" }));
    const res = await Promise.allSettled(Array.from({ length: 12 }, () => createReservation(base({ attendees: 1, startTime: "16:00", endTime: "17:00" }))));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(res.filter((r) => r.status === "rejected").every((r) => /Sin cupo/.test(String((r as PromiseRejectedResult).reason?.message)))).toBe(true);
    const used = await db.reservation.aggregate({ where: { tenantId: A, date: day, startTime: "16:00" }, _sum: { attendees: true } });
    expect(used._sum.attendees).toBe(10);
  }, 240000);

  it("las canceladas liberan cupo y los pools (ludoteca/guardería) son independientes", async () => {
    const id = await createReservation(base({ attendees: 10, startTime: "18:00", endTime: "19:00" }));
    await fail(createReservation(base({ attendees: 1, startTime: "18:00", endTime: "19:00" })), /Sin cupo/);
    await cancelReservation(A, id, false);
    await expect(createReservation(base({ attendees: 10, startTime: "18:00", endTime: "19:00" }))).resolves.toBeTruthy();
    // guardería tiene su propia capacidad (4) aunque ludoteca esté llena
    await expect(createReservation(base({ serviceType: "GUARDERIA", attendees: 4, startTime: "18:00", endTime: "19:00" }))).resolves.toBeTruthy();
    await fail(createReservation(base({ serviceType: "GUARDERIA", attendees: 1, startTime: "18:00", endTime: "19:00" })), /quedan 0 de 4/);
  }, 120000);

  it("espacios exclusivos: sin dobles reservas aun con intentos simultáneos", async () => {
    const mk = () => createReservation(base({ serviceType: "CUMPLEANOS", spaceId: spaceA, attendees: 15, date: day2, startTime: "15:00", endTime: "18:00" }));
    const res = await Promise.allSettled([mk(), mk(), mk(), mk()]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected").every((r) => /espacio ya está reservado/.test(String((r as PromiseRejectedResult).reason?.message)))).toBe(true);
    await expect(createReservation(base({ serviceType: "EVENTO", spaceId: spaceA, date: day2, startTime: "18:00", endTime: "20:00" }))).resolves.toBeTruthy(); // contiguo
    await fail(createReservation(base({ serviceType: "EVENTO", spaceId: spaceA, date: day2, startTime: "17:00", endTime: "19:00" })), /ya está reservado/);
  }, 180000);

  it("bloqueos de horario: del local completo o de un espacio", async () => {
    const d = addDays(limaDate(), 12);
    await db.scheduleBlock.create({ data: { tenantId: A, date: d, startTime: "09:00", endTime: "11:00", reason: "Mantenimiento", createdById: uA } });
    await fail(createReservation(base({ date: d, startTime: "10:00", endTime: "10:30" })), /Horario bloqueado: Mantenimiento/);
    await fail(createReservation(base({ serviceType: "CUMPLEANOS", spaceId: spaceA, date: d, startTime: "10:00", endTime: "12:00" })), /Horario bloqueado/);
    await expect(createReservation(base({ date: d, startTime: "11:00", endTime: "12:00" }))).resolves.toBeTruthy();
    const d2 = addDays(limaDate(), 13);
    await db.scheduleBlock.create({ data: { tenantId: A, date: d2, startTime: "09:00", endTime: "20:00", spaceId: spaceA, reason: "Sala en reparación", createdById: uA } });
    await fail(createReservation(base({ serviceType: "CUMPLEANOS", spaceId: spaceA, date: d2, startTime: "10:00", endTime: "12:00" })), /Sala en reparación/);
    await expect(createReservation(base({ date: d2, startTime: "10:00", endTime: "12:00" }))).resolves.toBeTruthy(); // ludoteca no afectada
    await expect(db.scheduleBlock.create({ data: { tenantId: A, date: d2, startTime: "12:00", endTime: "10:00", reason: "x", createdById: uA } })).rejects.toThrow();
  }, 180000);

  it("aislamiento: B no ve cupos ni espacios de A", async () => {
    const d = addDays(limaDate(), 14);
    for (let i = 0; i < 2; i++) await createReservation(base({ date: d, attendees: 5, startTime: "10:00", endTime: "11:00" })); // A lleno
    await expect(createReservation({ ...base({ date: d, attendees: 5, startTime: "10:00", endTime: "11:00" }), tenantId: B, userId: uB })).resolves.toBeTruthy();
    await expect(createReservation({ ...base({ serviceType: "CUMPLEANOS", spaceId: spaceA, date: d }), tenantId: B, userId: uB })).rejects.toThrow(/espacio/);
    const r = await db.reservation.findFirstOrThrow({ where: { tenantId: A, date: d } });
    await expect(confirmReservation(B, r.id)).rejects.toThrow(/no encontrada/);
    await expect(cancelReservation(B, r.id, true)).rejects.toThrow(/no encontrada/);
    await expect(payReservation({ tenantId: B, userId: uB, reservationId: r.id, amountCents: 100, pay: cash, idempotencyKey: key() })).rejects.toThrow(/no encontrada|abierto/);
  }, 180000);

  it("la BD rechaza reservas incoherentes (pagado > total, hora inválida)", async () => {
    const r = await db.reservation.findFirstOrThrow({ where: { tenantId: A } });
    await expect(db.$executeRaw`UPDATE "Reservation" SET "advancePaidCents" = "totalAmountCents" + 1 WHERE "id" = ${r.id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Reservation" SET "startTime" = '25:99' WHERE "id" = ${r.id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Reservation" SET "attendees" = 0 WHERE "id" = ${r.id}`).rejects.toThrow();
  }, 90000);

  it("adelantos: sin turno abierto no se cobra; con turno entra a la caja y vincula el turno", async () => {
    const id = await createReservation(base({ date: addDays(limaDate(), 20), startTime: "10:00", endTime: "11:00", totalAmountCents: 20000, advanceRequiredCents: 5000 }));
    await fail(payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 5000, pay: cash, idempotencyKey: key() }), /turno de caja abierto/);
    expect((await db.reservation.findFirstOrThrow({ where: { id } })).advancePaidCents).toBe(0);
    expect(await db.sale.count({ where: { tenantId: A, reservationId: id } })).toBe(0);

    const session = await openCashSession(A, uA, 10000);
    const k = key();
    const r1 = await payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 5000, pay: { first: "EFECTIVO", firstAmountCents: 2000, second: "YAPE_PLIN" }, idempotencyKey: k });
    expect(r1.balanceAfter).toBe(15000);
    const res = await db.reservation.findFirstOrThrow({ where: { id } });
    expect(res.advancePaidCents).toBe(5000);
    expect(res.advanceCashSessionId).toBe(session.id);
    expect(res.status).toBe("CONFIRMED"); // alcanzó el adelanto requerido → confirmación automática
    const sale = await db.sale.findFirstOrThrow({ where: { id: r1.saleId, tenantId: A }, include: { items: true } });
    expect([sale.kind, sale.cashRegisterSessionId, sale.cashCents, sale.yapePlinCents]).toEqual(["RESERVATION_PAYMENT", session.id, 2000, 3000]);
    expect(sale.items[0]!.description).toMatch(/^Adelanto/);
    await fail(payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 5000, pay: cash, idempotencyKey: k }), /duplicada/); // doble clic
    expect((await db.reservation.findFirstOrThrow({ where: { id } })).advancePaidCents).toBe(5000);
  }, 180000);

  it("saldos: no se paga más que el total (ni simultáneamente) y no se completa con saldo pendiente", async () => {
    const id = await createReservation(base({ date: addDays(limaDate(), 21), startTime: "10:00", endTime: "11:00", totalAmountCents: 10000, advanceRequiredCents: 0 }));
    await fail(payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 10001, pay: cash, idempotencyKey: key() }), /supera el saldo/);
    await fail(payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 0, pay: cash, idempotencyKey: key() }), /inválido/);
    await confirmReservation(A, id);
    await payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 4000, pay: cash, idempotencyKey: key() });
    await fail(completeReservation(A, id), /saldo pendiente/);
    // 5 cobros simultáneos de 3000 sobre un saldo de 6000: solo caben 2
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 3000, pay: cash, idempotencyKey: key() })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const r = await db.reservation.findFirstOrThrow({ where: { id } });
    expect(r.advancePaidCents).toBe(10000);
    const paid = await db.sale.aggregate({ where: { tenantId: A, reservationId: id }, _sum: { totalCents: true } });
    expect(paid._sum.totalCents).toBe(10000); // lo cobrado en caja coincide exactamente con lo registrado en la reserva
    await completeReservation(A, id);
    expect((await db.reservation.findFirstOrThrow({ where: { id } })).status).toBe("COMPLETED");
    await fail(payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 1, pay: cash, idempotencyKey: key() }), /no encontrada|ya no admite/);
  }, 240000);

  it("cancelación con adelanto exige confirmar que no se devuelve; estados terminales no cambian", async () => {
    const id = await createReservation(base({ date: addDays(limaDate(), 22), startTime: "10:00", endTime: "11:00", totalAmountCents: 10000, advanceRequiredCents: 0 }));
    await payReservation({ tenantId: A, userId: uA, reservationId: id, amountCents: 2000, pay: cash, idempotencyKey: key() });
    await fail(cancelReservation(A, id, false), /no se devuelve/);
    await cancelReservation(A, id, true);
    await fail(confirmReservation(A, id), /no permitida/);
    await fail(markNoShow(A, id), /no permitida/);
    const id2 = await createReservation(base({ date: addDays(limaDate(), 22), startTime: "12:00", endTime: "13:00" }));
    await fail(markNoShow(A, id2), /no permitida/); // PENDING no puede ser no-show
    await confirmReservation(A, id2); await markNoShow(A, id2);
    expect((await db.reservation.findFirstOrThrow({ where: { id: id2 } })).status).toBe("NO_SHOW");
  }, 180000);

  it("el arqueo cuadra: los adelantos en efectivo suman al esperado del turno; los electrónicos no", async () => {
    const open = (await getOpenSession(A))!;
    const sales = await db.sale.aggregate({ where: { tenantId: A, cashRegisterSessionId: open.id }, _sum: { cashCents: true, yapePlinCents: true } });
    const closed = await closeCashSession(A, uA, 0);
    expect(closed.expectedCashCents).toBe(10000 + (sales._sum.cashCents ?? 0));
    expect(sales._sum.yapePlinCents).toBe(3000);
    const s = await db.cashRegisterSession.findFirstOrThrow({ where: { id: open.id } });
    expect(s.cashSalesCents).toBe(sales._sum.cashCents);
    expect(s.yapePlinSalesCents).toBe(3000);
  }, 120000);
});
