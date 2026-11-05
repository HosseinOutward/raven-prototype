package database

// workshopStatements adds the two Workshop capabilities. Both start allowed, so applying
// this changes nothing for anyone: port sharing is gated by the server's own switch
// (RAVEN_WORKSHOP_PORTS), which is off until a self-hoster turns it on.
func workshopStatements() []string {
	return []string{
		`INSERT INTO server_capability_defaults (capability, allowed, limit_value, updated_at)
		 VALUES ('` + CapabilityWorkshopSharePorts + `', TRUE, NULL, '2026-11-06T00:00:00Z') ON CONFLICT(capability) DO NOTHING`,
		`INSERT INTO server_capability_defaults (capability, allowed, limit_value, updated_at)
		 VALUES ('` + CapabilityWorkshopUsePorts + `', TRUE, NULL, '2026-11-06T00:00:00Z') ON CONFLICT(capability) DO NOTHING`,
	}
}
