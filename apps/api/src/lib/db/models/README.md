Models are the only way the codebase talks to the database. Every table has a model class in this directory, and nothing outside it writes SQL.

- Static methods find, list and create rows (`Download.find(id)`, `Candidate.pendingFor(...)`).
- They return model instances: one object per row, with typed camelCase fields and methods for the changes that row can undergo (`download.setStatus(...)`, `candidate.reject(reason)`).
- Instances serialise themselves into the shared API types from `@findr/types` (`toSummary()`, `toRecord()`), so routes never shape rows by hand.
- Multi-model writes go through `Model.transaction(() => ...)`.

Schema changes are migrations in `../migrations.ts`, applied by `../Migrator.ts` on startup.
