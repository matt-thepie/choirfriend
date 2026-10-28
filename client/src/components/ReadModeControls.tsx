import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';

/** A permanent way back to controls, including for touch and keyboard readers. */
export function ReadModeControls({ toolsOpen, onShow, onExit }: {
  toolsOpen: boolean;
  onShow: () => void;
  onExit?: () => void;
}) {
  const [guide, setGuide] = useState(() => {
    try { return sessionStorage.getItem('choirfriend.readGuide.v1') !== 'seen'; } catch { return true; }
  });
  return (
    <div className="absolute bottom-12 right-3 z-30 max-w-[min(22rem,calc(100%-1.5rem))] rounded-lg border border-border bg-background/95 p-2 shadow-card text-sm">
      {guide && (
        <div className="p-2 space-y-2">
          <p>Read mode opens automatically to give the music more room. Tap the middle of the music or use Show controls to find playback and viewing tools. Edge taps turn pages; a flowing bar tap selects where playback starts.</p>
          <p>Controls stay visible while you use the keyboard. Exit read mode returns to the full viewer; Escape also exits.</p>
          <Button size="sm" variant="outline" onClick={() => {
            setGuide(false);
            try { sessionStorage.setItem('choirfriend.readGuide.v1', 'seen'); } catch { /* storage blocked */ }
          }}>Got it</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground px-1">Read mode</span>
        {!toolsOpen && <Button size="sm" variant="outline" onClick={onShow}>Show controls</Button>}
        {onExit && <Button size="sm" variant="outline" onClick={onExit}>Exit read mode</Button>}
      </div>
    </div>
  );
}
