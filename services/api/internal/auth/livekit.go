package auth

import (
	"encoding/json"
	"time"

	livekitauth "github.com/livekit/protocol/auth"
)

type LiveKitTokenInput struct {
	APIKey    string
	APISecret string
	Session   string
	Identity  string
	Name      string
	Role      string
	ValidFor  time.Duration
}

func SignLiveKitToken(input LiveKitTokenInput) (string, error) {
	if input.ValidFor <= 0 {
		input.ValidFor = 2 * time.Hour
	}

	canPublish := true
	canSubscribe := true
	canPublishData := true
	canUpdateOwnMetadata := true
	metadata, err := json.Marshal(map[string]string{
		"app":  "Raven",
		"role": input.Role,
	})
	if err != nil {
		return "", err
	}

	token := livekitauth.NewAccessToken(input.APIKey, input.APISecret)
	token.AddGrant(&livekitauth.VideoGrant{
		RoomJoin:             true,
		Room:                 input.Session,
		CanPublish:           &canPublish,
		CanSubscribe:         &canSubscribe,
		CanPublishData:       &canPublishData,
		CanUpdateOwnMetadata: &canUpdateOwnMetadata,
	}).
		SetIdentity(input.Identity).
		SetName(input.Name).
		SetMetadata(string(metadata)).
		SetValidFor(input.ValidFor)

	return token.ToJWT()
}
