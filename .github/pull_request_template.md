<!-- Thanks for contributing to NoMoreIDE! Please fill out the sections below. -->

## What does this PR do?

<!-- A clear, concise description of the change and the motivation behind it. -->

## Release note

<!-- Goes verbatim into the GitHub Release if this PR ships a version, so write
     it for someone installing the app, not for a reviewer: what they can now
     do, not which files moved. Delete this section if the change is internal —
     the release then falls back to the description above. -->

## Related issues

<!-- e.g. "Closes #123". Leave blank if none. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal cleanup
- [ ] Documentation
- [ ] Other:

## How was this tested?

<!-- Commands run, manual steps, or new automated tests. -->

- [ ] `npm test` passes
- [ ] `npm run build` succeeds

## Checklist

- [ ] Change is a vertical slice (core + routes + MCP + UI as relevant), not edits scattered across god-files
- [ ] Respects existing safety boundaries (read-safe Git/DB; write ops stay in their guarded modules)
- [ ] No secrets, tokens, or credentials committed
- [ ] Updated docs / README where behavior changed
