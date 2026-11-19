import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifyToken } from "@/lib/auth/token";

// Comprobación optimista (solo presencia de cookie) para las rutas de cada establecimiento. La validación real
// ocurre en el servidor con getCurrentUser()/requirePermission().
// /superadmin/* es más estricto: se verifica la FIRMA del token y la marca de SuperAdmin ya en el proxy
// (defensa en profundidad; las páginas y acciones vuelven a verificar con requireSuperAdmin()).
const PROTECTED = ["/dashboard", "/families", "/playground", "/daycare", "/teachers", "/reservations",
  "/cash-register", "/products", "/subscriptions", "/reports", "/whatsapp", "/settings", "/expenses", "/marketing", "/billing", "/change-password"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Portal de padres: cookie propia (pq_parent). Solo /parent-portal/login es público.
  if (pathname.startsWith("/parent-portal") && !pathname.startsWith("/parent-portal/login") && !req.cookies.get("pq_parent")) {
    return NextResponse.redirect(new URL("/parent-portal/login", req.url));
  }
  if (pathname === "/superadmin" || pathname.startsWith("/superadmin/")) {
    const session = await verifyToken(req.cookies.get(COOKIE)?.value);
    if (!session) return NextResponse.redirect(new URL("/login", req.url));
    // Sesión válida pero sin marca de SuperAdmin (p. ej. el OWNER de un establecimiento): la ruta "no existe" para él
    if (!session.sa) return new NextResponse("No encontrado", { status: 404 });
    return NextResponse.next();
  }
  if (PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/")) && !req.cookies.get(COOKIE)) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!api|_next|favicon.ico).*)"] };
