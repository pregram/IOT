import type { LucideIcon } from 'lucide-react';
import {
  Armchair,
  Box,
  Gamepad2,
  Laptop,
  Leaf,
  PencilRuler,
  Shirt,
  Utensils,
} from 'lucide-react';
import type { ThemeId } from './types';

/** Lucide icon per theme, shared by the join screen and the landing page. */
export const THEME_ICONS: Record<ThemeId, LucideIcon> = {
  everyday: Box,
  food: Utensils,
  nature: Leaf,
  clothes: Shirt,
  tech: Laptop,
  hobbies: Gamepad2,
  tools: PencilRuler,
  furniture: Armchair,
};

/** Per-player identity colors, assigned at join (index = join order). */
export const PLAYER_COLORS = [
  '#f59e0b', // amber
  '#10b981', // emerald
  '#8b5cf6', // violet
  '#ef4444', // red
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
  '#f97316', // orange
];

export function playerColor(index: number): string {
  return PLAYER_COLORS[Math.abs(index) % PLAYER_COLORS.length];
}
