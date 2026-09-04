# Version 2 dual-run comparison

Use this migration-only path to compare the current version 1 profile-sync
workflow with the Creator Scouting MCP version 2 read and acquisition path. It
does not authorize a destination write, profile-write activation, scheduled-
route switch, or version 1 retirement.

## Required sequence

1. Prepare one private, reviewed target manifest. Do not regenerate or alter it
   between paths.
2. Run the current version 1 acquisition and destination dry-run path with that
   manifest.
3. Convert that exact profile manifest to the Creator Scouting MCP target
   envelope with `toCreatorScoutingProfileTargetManifest` from
   `scripts/profile_v2_dual_run.mjs`. The adapter changes only the envelope
   version and input-kind placement; it preserves the generated time, target
   mode, ordered Creator-record/account pairs, and row count. Call
   `observe_creator_profiles` with the converted manifest. If it returns
   interaction instructions, follow them only in the selected private session
   and preserve the returned source context and completed MCP target manifest.
4. Call `validate_creator_profile_observations` with the exact returned target
   manifest, source context, and observations.
5. Run the destination dry-run planner with the validated version 2
   observations. Do not apply either plan.
6. Create one owner-only comparison input and run:

   `scripts/compare_profile_v2_dual_run.mjs --input INPUT.json --output REPORT.json`

The comparator checks target coverage, normalized values, proposed mutations,
unavailable values, and stop reasons. A target-manifest mismatch blocks the
comparison. A dry-run plan that does not match its recorded hash, path manifest,
or path observations is rejected. Differences must be reviewed rather than
normalized away.

The current profile Skill manifest is version 2 and carries `inputKind`; the
Creator Scouting MCP target envelope is version 1 and supplies input kind at its
own provider boundary. The version 2 path must therefore include its returned
`mcpTargetManifest`. The comparator independently verifies that this envelope
maps one-to-one to the original reviewed profile manifest. Do not hand-edit or
silently coerce either manifest.

Avatar comparison uses verified SHA-256, byte size, and MIME type. Private
local paths and file names are excluded from semantic comparison because the
two paths may materialize identical bytes at different owner-only locations.
Signed source URLs, raw source payloads, screenshots, and credentials never
belong in the comparison input.

## Private comparison input

```json
{
  "version": 1,
  "skill": "creator-profile-sync",
  "generatedAt": "2030-01-02T03:04:05.000Z",
  "reviewedTargetManifest": {},
  "paths": {
    "v1": {
      "status": "completed",
      "targetManifest": {},
      "observations": {},
      "dryRunPlan": {},
      "unavailableValues": [],
      "stopReasons": []
    },
    "v2": {
      "status": "completed",
      "targetManifest": {},
      "mcpTargetManifest": {},
      "observations": {},
      "dryRunPlan": {},
      "unavailableValues": [],
      "stopReasons": []
    }
  }
}
```

For a stopped path, set `status` to `stopped`, omit `observations` and
`dryRunPlan`, and include at least one structured `stopReasons` entry. The
version 2 path still records the completed `mcpTargetManifest`; failure before
that envelope can be completed is an invalid comparison input rather than a
comparable stopped acquisition. Keep the input and report outside Git because
they contain Creator and Lark record identifiers.

Even an `equivalent` report remains comparison-only. A route switch still
requires an active profile-history domain write route, explicit scheduled-route
approval, and two successful scheduled version 2 cycles with the version 1
rollback retained.
