import { useCallback, useEffect, useState } from "react";

export type ParticipantMediaPreference = {
  voiceVolume: number;
  voiceMuted: boolean;
  sharedAudioVolume: number;
  sharedAudioMuted: boolean;
  cameraReceiving: boolean;
};

export const DEFAULT_PARTICIPANT_MEDIA_PREFERENCE: ParticipantMediaPreference = {
  voiceVolume: 1,
  voiceMuted: false,
  sharedAudioVolume: 1,
  sharedAudioMuted: false,
  cameraReceiving: true,
};

export function preferenceForParticipant(preferences: Record<string, ParticipantMediaPreference>, participantId: string) {
  return preferences[participantId] ?? DEFAULT_PARTICIPANT_MEDIA_PREFERENCE;
}

export function updateParticipantPreference(
  preferences: Record<string, ParticipantMediaPreference>,
  participantId: string,
  patch: Partial<ParticipantMediaPreference>,
) {
  return {
    ...preferences,
    [participantId]: { ...preferenceForParticipant(preferences, participantId), ...patch },
  };
}

export function useParticipantMediaPreferences(
  connected: boolean,
  setCameraReceiving: (participantId: string, receiving: boolean) => Promise<void>,
) {
  const [preferences, setPreferences] = useState<Record<string, ParticipantMediaPreference>>({});

  useEffect(() => {
    if (!connected) setPreferences({});
  }, [connected]);

  const updatePreference = useCallback((participantId: string, patch: Partial<ParticipantMediaPreference>) => {
    setPreferences((current) => updateParticipantPreference(current, participantId, patch));
    if (typeof patch.cameraReceiving === "boolean") {
      void setCameraReceiving(participantId, patch.cameraReceiving).catch(() => undefined);
    }
  }, [setCameraReceiving]);

  const getPreference = useCallback(
    (participantId: string) => preferenceForParticipant(preferences, participantId),
    [preferences],
  );

  return { getPreference, updatePreference };
}
