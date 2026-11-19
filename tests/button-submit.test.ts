import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";

describe("Button dentro de formularios", () => {
  it("envía el formulario por defecto (type=submit)", () => {
    expect(renderToStaticMarkup(h("form", null, h(Button, null, "Guardar")))).toContain('type="submit"');
  });
  it("permite type=button explícito", () => {
    expect(renderToStaticMarkup(h(Button, { type: "button" }, "Ok"))).toContain('type="button"');
  });
});
