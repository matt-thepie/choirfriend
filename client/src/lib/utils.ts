import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Standard shadcn helper: merge Tailwind classes intelligently. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
