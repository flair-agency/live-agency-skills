# Private Lark configuration

Store this JSON outside the public repository as an owner-only (`0600`) file.

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-creator-table-id",
  "profileTableId": "local-profile-table-id",
  "metricTableId": "local-live-metric-table-id",
  "tagTableId": "local-feature-tag-table-id",
  "insightViewId": "local-due-view-id",
  "fieldIds": {
    "creatorAccount": "field-id",
    "creatorInsight": "field-id",
    "creatorTraits": "field-id",
    "profileTimestamp": "field-id",
    "profileCreator": "field-id",
    "profileFeatureObservationData": "field-id",
    "metricTimestamp": "field-id",
    "metricCreator": "field-id",
    "metricFanClub": "field-id",
    "metricLatestLiveAt": "field-id",
    "metricLiveDays30d": "field-id",
    "metricLiveHours30d": "field-id",
    "metricLikes30d": "field-id",
    "tagVocabulary": "field-id"
  }
}
```

All field IDs must be present and distinct. Profile and metric creator fields
must be single relations to the creator table. The profile feature field must
be text; metric values must be ordinary snapshot date/number fields.

`creatorTraits` and `tagVocabulary` must both be multi-select fields. The
creator field synchronizes its options from the tag-table field, and both
option-name sets must match exactly. The tag table governs vocabulary; this
skill never changes records or options.

The configuration contains destination identifiers, not credentials. Never
commit it or generated contexts, proposals, plans, or real Lark records.
