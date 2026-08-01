---
sdd:
    type: capability
    id: CAP-7E001BA8
---

# Approval-gated exact patching

## Purpose <!-- sdd:purpose -->

Allow the agent to propose a bounded text-file change while trusted harness
code retains target authorization, complete preview, terminal approval,
revalidation, atomic application, and lifecycle-result ownership.

<a id="req-32b1f442"></a>

## REQ-32B1F442 — Apply bounded exact replacements

```sdd
kind: invariant
verification: automated
```

### Statement <!-- sdd:statement -->

A patch proposal shall contain only bounded, exact, non-overlapping
replacements evaluated against one original UTF-8 text version.

### Acceptance criteria <!-- sdd:acceptance -->

- Every replacement matches exactly one region in the original text.
- Duplicate, missing, non-unique, overlapping, no-op, malformed, or oversized
  replacements are rejected without producing an applicable proposal.
- The result preserves an existing UTF-8 BOM and the source's dominant line
  ending style.

<a id="req-60e10f76"></a>

## REQ-60E10F76 — Authorize one safe existing target

```sdd
kind: constraint
verification: automated
```

### Statement <!-- sdd:statement -->

Each patch proposal shall target exactly one authorized existing regular file
inside the approved workspace.

### Acceptance criteria <!-- sdd:acceptance -->

- Lexical and canonical path traversal outside the workspace is rejected.
- Sensitive paths, symlinks, missing paths, and non-regular targets are
  rejected.
- Authorization is performed by trusted harness code rather than by the
  proposing model.

<a id="req-17b4c424"></a>

## REQ-17B4C424 — Require explicit approval of the complete preview

```sdd
kind: constraint
verification: automated
```

### Statement <!-- sdd:statement -->

The harness shall prepare a complete immutable patch preview and apply nothing
unless an available interactive terminal receives explicit approval for that
preview.

### Acceptance criteria <!-- sdd:acceptance -->

- The approval view contains the complete display diff without mutable
  proposal internals.
- Only `y` or `yes`, compared case-insensitively after trimming, approves the
  preview.
- Missing, declined, invalid, aborted, failed, or non-interactive approval
  leaves the workspace unchanged.

<a id="req-245f8421"></a>

## REQ-245F8421 — Revalidate and replace atomically

```sdd
kind: invariant
verification: automated
```

### Statement <!-- sdd:statement -->

Immediately before applying an approved patch, the harness shall reauthorize
the target and verify the approved base and result before a same-directory
atomic replacement.

### Acceptance criteria <!-- sdd:acceptance -->

- A changed path, source, or proposal result is reported as a conflict without
  replacing the target.
- A successful replacement preserves the original file mode.
- Abort, timeout, temporary-write failure, and rename failure leave the target
  intact and settle before the operation returns.

<a id="req-d8b3adc2"></a>

## REQ-D8B3ADC2 — Settle one safe lifecycle result

```sdd
kind: invariant
verification: automated
```

### Statement <!-- sdd:statement -->

Every patch proposal call shall resolve exactly once with ordered, sanitized
runtime lifecycle events and one outcome that states whether the patch was
applied.

### Acceptance criteria <!-- sdd:acceptance -->

- Validation, permission, preparation, approval, application, conflict,
  timeout, and failure outcomes are normalized without duplicate settlement.
- Lifecycle observers receive ordered detached snapshots and cannot change
  runtime state or transcript content.
- Denial or failure returns a safe read-only result that does not claim the
  patch was applied.
