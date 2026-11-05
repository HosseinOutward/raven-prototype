package auth

import (
	"testing"

	"github.com/livekit/protocol/livekit"
)

func TestCallGrantsLimitOnlyAudio(t *testing.T) {
	free := VoiceLimits{}
	muted := VoiceLimits{Muted: true}
	deafened := VoiceLimits{Deafened: true}
	for _, kind := range []IdentityKind{IdentityViewer, IdentityAudio, IdentityVideo} {
		grants := CallGrantsFor(kind, free)
		if !grants.CanPublish || !grants.CanSubscribe || len(grants.PublishSources) != 0 {
			t.Fatalf("kind %d without limits should be unrestricted: %+v", kind, grants)
		}
	}
	audio := CallGrantsFor(IdentityAudio, muted)
	if audio.CanPublish || !audio.CanSubscribe {
		t.Fatalf("a muted person still hears, and sends no audio: %+v", audio)
	}
	audio = CallGrantsFor(IdentityAudio, deafened)
	if audio.CanPublish || audio.CanSubscribe {
		t.Fatalf("a deafened person neither hears nor is heard: %+v", audio)
	}
	for _, kind := range []IdentityKind{IdentityViewer, IdentityVideo} {
		for _, limits := range []VoiceLimits{muted, deafened} {
			grants := CallGrantsFor(kind, limits)
			if !grants.CanPublish || !grants.CanSubscribe {
				t.Fatalf("video must keep working for kind %d: %+v", kind, grants)
			}
			if len(grants.PublishSources) != 2 {
				t.Fatalf("kind %d must be narrowed to video sources: %+v", kind, grants)
			}
			for _, source := range grants.PublishSources {
				if source != livekit.TrackSource_CAMERA && source != livekit.TrackSource_SCREEN_SHARE {
					t.Fatalf("kind %d may still send %v", kind, source)
				}
			}
		}
	}
}

// LiveKit's update replaces the whole set, so losing these would break reconcile's metadata.
func TestPermissionKeepsDataAndMetadataRights(t *testing.T) {
	permission := CallGrantsFor(IdentityAudio, VoiceLimits{Deafened: true}).Permission()
	if !permission.CanPublishData || !permission.CanUpdateMetadata {
		t.Fatalf("data and metadata rights were dropped: %+v", permission)
	}
}
