import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.ts';

/**
 * Buttons per the design tokens: primary (accent), secondary/outline (white
 * with border), ghost (text), danger. Every size is a full tap target.
 */

type Variant = 'default' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active shadow-sm',
  outline: 'border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground',
  ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
  danger: 'bg-destructive text-destructive-foreground hover:opacity-90',
};

const sizes: Record<Size, string> = {
  sm: 'h-10 px-4 text-sm',
  md: 'h-11 px-6 text-base',
  lg: 'h-12 px-7 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-md font-semibold transition-colors duration-150 whitespace-nowrap',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:opacity-50',
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

/** A 44px icon button with a Material Symbols glyph. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; filled?: boolean; size?: 'sm' | 'md' }
>(({ className, icon, label, filled, size = 'md', ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-label={label}
    title={label}
    className={cn(
      'inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors duration-150 shrink-0',
      'disabled:opacity-40 disabled:pointer-events-none',
      size === 'md' ? 'w-11 h-11' : 'w-10 h-10',
      className,
    )}
    {...props}
  >
    <span className={cn('msym', filled && 'msym-fill')} aria-hidden>{icon}</span>
  </button>
));
IconButton.displayName = 'IconButton';

/** Inline Material Symbols glyph. */
export function Icon({ name, className, filled }: { name: string; className?: string; filled?: boolean }) {
  return <span className={cn('msym', filled && 'msym-fill', className)} aria-hidden>{name}</span>;
}
