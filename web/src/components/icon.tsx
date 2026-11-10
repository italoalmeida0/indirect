import type { JSX } from "solid-js";

import { Glyph, type GlyphData } from "../ds/components/icon";

export type IconData = GlyphData;

export interface IconProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "stroke-width"> {
  icon: string | IconData;
  size?: number;
  class?: string;
  strokeWidth?: number;
}

/**
 * Indirect Code icon: the design-system Glyph (build-time registry, one
 * stroke width for every lucide icon, 1em by default so it follows text).
 */
export function Icon(props: IconProps) {
  return <Glyph {...props} />;
}

export default Icon;
