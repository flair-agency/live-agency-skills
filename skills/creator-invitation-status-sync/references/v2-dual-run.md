# Version 2 dual-run comparison

Use this migration-only path to compare the current version 1 invitation-status
workflow with the Creator Scouting MCP version 2 read and acquisition path. It
does not authorize a scheduled-route switch or any write.

## Required sequence

1. Prepare one private, reviewed target manifest. Do not regenerate or alter it
   between paths.
2. Run the current version 1 acquisition and dry-run path with that manifest.
3. Call `observe_creator_invitation_eligibility` with the same manifest. If it
   returns interaction instructions, follow them only in the selected private
   session and preserve the returned source context.
4. Call `validate_creator_invitation_eligibility_observations` with the exact
   returned target manifest, source context, and observations.
5. Run the destination dry-run planner with the validated version 2
   observations. Do not apply either plan.
6. Create one owner-only comparison input and run:

   `scripts/compare_invitation_v2_dual_run.mjs --input INPUT.json --output REPORT.json`

The comparator checks target coverage, normalized values, proposed mutations,
unavailable values, and stop reasons. A target-manifest mismatch blocks the
comparison. Differences produce a nonzero result and must be reviewed rather
than normalized away.

## Private comparison input

```json
{
  "version": 1,
  "skill": "creator-invitation-status-sync",
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
      "observations": {},
      "dryRunPlan": {},
      "unavailableValues": [],
      "stopReasons": []
    }
  }
}
```

For a stopped path, set `status` to `stopped`, omit `observations` and
`dryRunPlan`, and include at least one structured `stopReasons` entry. Keep the
input and report outside Git because they contain Creator and Lark record
identifiers.

Even an `equivalent` report remains comparison-only. A route switch still
requires an active invitation-history domain write route, explicit scheduled-
route approval, and two successful scheduled version 2 cycles with the version
1 rollback retained.
