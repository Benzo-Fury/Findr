import type { ComponentProps, ReactNode } from 'react';

import { AudioTrackMenu } from '@/components/videojs/ui/audio-track-menu';
import { CaptionsSubmenu } from '@/components/videojs/ui/captions-submenu';
import { PlaybackRateSubmenu } from '@/components/videojs/ui/playback-rate-submenu';
import { QualityMenu } from '@/components/videojs/ui/quality-menu';
import { SettingsMenu } from '@/components/videojs/ui/settings-menu';

export interface VideoSettingsMenuProps extends Omit<NonNullable<ComponentProps<typeof SettingsMenu>>, 'children'> {
  /** Findr: the menu's items, in place of the skin's own. */
  children?: ReactNode;
}

export function VideoSettingsMenu({ children, ...props }: VideoSettingsMenuProps = {}) {
  return (
    <SettingsMenu {...props}>
      {children ?? (
        <>
          <QualityMenu />
          <AudioTrackMenu />
          <PlaybackRateSubmenu />
          <CaptionsSubmenu />
        </>
      )}
    </SettingsMenu>
  );
}
