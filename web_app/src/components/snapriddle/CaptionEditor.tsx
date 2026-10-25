'use client';

/**
 * Caption moderation editor (host only).
 * A compact dialog that lets the host tweak or clear the one-line caption
 * a player typed under their accepted proof photo. Used from both the
 * HostDashboard result polaroid and the VictoryScreen gallery/lightbox.
 */

import { useState } from 'react';
import { Eraser, MessageCircle, Save, X } from 'lucide-react';
import type { PhotoMoment } from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CaptionEditorProps {
  /** the moment being edited - null closes the editor */
  moment: PhotoMoment | null;
  onClose: () => void;
  /** text = save caption (already trimmed/capped) · null = remove caption */
  onSave: (momentId: string, text: string | null) => void;
}

export default function CaptionEditor({ moment, onClose, onSave }: CaptionEditorProps) {
  /* seeded on mount - parents remount this dialog per moment via `key` */
  const [text, setText] = useState(moment?.caption ?? '');

  const clean = text.trim().replace(/\s+/g, ' ').slice(0, 60);
  const canSave = clean.length > 0;
  const hadCaption = Boolean(moment?.caption);
  const dirty = moment ? (moment.caption ?? '') !== clean : false;

  return (
    <Dialog
      open={Boolean(moment)}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="dark-dialog max-w-sm border-violet-500/30 bg-[#101827]">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2 text-sm font-extrabold text-fg">
            <MessageCircle className="h-4 w-4 shrink-0 text-violet-400" aria-hidden />
            Edit photo caption
          </DialogTitle>
          <DialogDescription className="text-xs text-sr-3">
            {moment
              ? `${moment.player_name}'s “${moment.keyword}” proof · Round ${moment.round}`
              : 'Host caption moderation'}
          </DialogDescription>
        </DialogHeader>

        {moment && (
          <div className="space-y-3">
            {/* mini preview of the polaroid being captioned */}
            <div className="flex items-center gap-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.07] p-2">
              <img
                src={moment.photo}
                alt={`Proof of “${moment.keyword}” by ${moment.player_name}`}
                className="h-14 w-24 shrink-0 rounded-lg border-2 border-white/90 object-cover"
              />
              <div className="min-w-0 text-[10px] leading-relaxed text-sr-2">
                <span className="block truncate font-bold text-fg">{moment.player_name}</span>
                <span className="block truncate lowercase text-sr-3">“{moment.keyword}”</span>
                <span className={moment.points >= 0 ? 'font-bold text-emerald-400' : 'font-bold text-rose-400'}>
                  {moment.points >= 0 ? '+' : ''}
                  {moment.points} pts
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="caption-editor-input" className="text-[11px] font-bold text-sr-2">
                Caption {hadCaption ? '(editing)' : '(new)'}
              </Label>
              <Input
                id="caption-editor-input"
                value={text}
                maxLength={80}
                placeholder="A short, punchy line for the gallery…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave && dirty) {
                    onSave(moment.id, clean);
                    onClose();
                  }
                }}
                className="border-violet-500/40 bg-black/20 text-xs text-slate-100 placeholder:text-slate-500 focus-visible:ring-violet-500/60"
              />
              <div className="flex items-center justify-between text-[9px] text-sr-3">
                <span>Shows under the photo in the gallery, replay & share text.</span>
                <span className={clean.length > 55 ? 'font-bold text-amber-400' : ''}>{clean.length}/60</span>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                variant="secondary"
                onClick={onClose}
                className="flex-1 gap-1 text-xs font-bold"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
              {hadCaption && (
                <Button
                  variant="outline"
                  onClick={() => {
                    onSave(moment.id, null);
                    onClose();
                  }}
                  className="flex-1 gap-1 border-rose-500/40 bg-rose-500/10 text-xs font-bold text-rose-500 hover:bg-rose-500/25 hover:text-rose-400 dark:text-rose-400"
                >
                  <Eraser className="h-3.5 w-3.5" /> Clear
                </Button>
              )}
              <Button
                disabled={!canSave || !dirty}
                onClick={() => {
                  onSave(moment.id, clean);
                  onClose();
                }}
                className="flex-1 gap-1 bg-violet-500 text-xs font-bold text-white shadow-violet-500/30 hover:bg-violet-400"
              >
                <Save className="h-3.5 w-3.5" /> Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
