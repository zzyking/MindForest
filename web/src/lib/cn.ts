import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Tailwind-aware class merger. Use everywhere we'd otherwise write
 * template-literal class soup; resolves later classes winning over
 * earlier ones when they target the same property.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
