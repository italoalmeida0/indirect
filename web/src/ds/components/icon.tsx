import { registry } from "virtual:icons";
import { splitProps, type JSX } from "solid-js";

/**
 * One icon renderer for the whole app (gateway `ui.tsx` Icon and the
 * Indirect Code `components/icon.tsx` Icon both delegate here).
 *
 * Lucide bodies carry `stroke-width="2"` on every path, which silently
 * overrode the root attribute; the body is normalized once per icon so the
 * design-system stroke (1.75) and any explicit `strokeWidth` apply.
 * Icon names must appear as quoted literals somewhere in the source: the
 * build-time registry only bundles icons it can see.
 */
export interface GlyphData {
  body: string;
  height: number;
  width: number;
}

const normalized = new Map<string, string>();

function strokeBody(key: string, body: string): string {
  let cached = normalized.get(key);
  if (cached === undefined) {
    cached = body.replace(/\sstroke-width="[^"]*"/g, "");
    normalized.set(key, cached);
  }
  return cached;
}

export function resolveGlyph(icon: string | GlyphData): { data: GlyphData | undefined; stroked: boolean; key: string } {
  if (typeof icon !== "string") return { data: icon, stroked: /stroke=/.test(icon.body), key: icon.body };
  const data = registry[icon] ?? registry[`lucide:${icon}`];
  const stroked = icon.startsWith("lucide:") || !icon.includes(":") || !!data?.body.includes("stroke=");
  return { data, stroked, key: icon };
}

export interface GlyphProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "stroke-width"> {
  icon: string | GlyphData;
  /** Pixel size; defaults to 1em so the glyph follows the text. */
  size?: number;
  strokeWidth?: number;
  class?: string;
}

export function Glyph(props: GlyphProps) {
  const [local, rest] = splitProps(props, ["icon", "size", "strokeWidth", "class", "style"]);
  const resolved = () => resolveGlyph(local.icon);
  const body = () => {
    const { data, stroked, key } = resolved();
    if (!data) return "";
    return stroked ? strokeBody(key, data.body) : data.body;
  };
  const dimension = () => (local.size ? `${local.size}px` : "1em");
  return (
    /* eslint-disable solid/no-innerhtml -- icon bodies come from the build-time icon registry, never user input */
    <svg
      {...rest}
      innerHTML={body()}
      viewBox={`0 0 ${resolved().data?.width ?? 24} ${resolved().data?.height ?? 24}`}
      xmlns="http://www.w3.org/2000/svg"
      width={dimension()}
      height={dimension()}
      fill={resolved().stroked ? "none" : undefined}
      stroke={resolved().stroked ? "currentColor" : undefined}
      stroke-width={resolved().stroked ? local.strokeWidth ?? 1.75 : undefined}
      stroke-linecap={resolved().stroked ? "round" : undefined}
      stroke-linejoin={resolved().stroked ? "round" : undefined}
      class={`inline-block shrink-0 ${local.class ?? ""}`}
      style={{ width: dimension(), height: dimension(), ...(typeof local.style === "object" ? local.style : {}) }}
      aria-hidden="true"
    />
    /* eslint-enable solid/no-innerhtml */
  );
}
