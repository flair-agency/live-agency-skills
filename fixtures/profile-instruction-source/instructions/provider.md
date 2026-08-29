# Synthetic profile observation provider

This fixture represents a manual observation provider used by automated tests.

1. Read every row in the target manifest.
2. Produce one normalized creator observation for every target and no others.
3. Preserve each creator record ID and normalized account key exactly.
4. Return the normalized profile-observation schema documented by the public skill.
5. Do not update the destination system.
