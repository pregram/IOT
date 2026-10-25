'use client';

import { BookOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/* The rules panel, shared by the host lobby and the player
   controller (it used to live inside HostLobby only). Short, no emojis.
   `audience` swaps the controls section: hosts get the host controls,
   players get what they can do from their phone. */
export default function RulesDialog({
  open,
  onOpenChange,
  numRounds,
  audience,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  numRounds: number;
  audience: 'host' | 'player';
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg rounded-2xl">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2 text-lg text-fg">
            <BookOpen className="h-5 w-5 text-amber-400" /> How SnapRiddle Works
          </DialogTitle>
          <DialogDescription className="text-xs text-sr-3">
            {audience === 'host'
              ? 'A 60-second brief for hosts — everything here also shows up in play.'
              : 'A quick brief before your turn — everything here also shows up in play.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-xs leading-relaxed text-sr-2">
          <section>
            <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-amber-500">Game flow</h4>
            <p>
              The match runs {numRounds} round{numRounds === 1 ? '' : 's'}. Each turn: a riddle is read aloud, the
              active player proves it on camera, and the AI judge scores the proof. Faster proofs score more.
            </p>
          </section>
          {audience === 'host' ? (
            <section>
              <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-amber-500">Host controls</h4>
              <p>
                <strong className="text-fg">Overrule AI</strong> reverses a wrong verdict and awards the points.{' '}
                <strong className="text-fg">Pivot to Paper</strong> accepts a drawing or a written answer instead of an
                object. Physical button: single press = snap or retake, double press = countdown capture, long press =
                hint for the active player.
              </p>
            </section>
          ) : (
            <section>
              <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-amber-500">Your turn</h4>
              <p>
                Your phone lights up when you are up. The clock starts once the riddle has been read. Find the answer
                and show it to the camera. <strong className="text-fg">Countdown Capture</strong> takes the photo for
                you after a short countdown, and the clock pauses meanwhile.{' '}
                <strong className="text-fg">Request Hint</strong> asks the Voice Master for a clue. You can also send
                reactions and captions to the TV.
              </p>
            </section>
          )}
          <section>
            <h4 className="text-[11px] font-extrabold uppercase tracking-wider text-amber-500">Scoring &amp; hints</h4>
            <p>
              One hint per riddle — solving with a hint pays half the points. The last round is Double or Doom: correct
              proofs double, misses cost double. Difficulty adapts between rounds to keep everyone challenged.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
