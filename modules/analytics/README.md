# module: analytics

**Bounded context.** read-only projections — A/R, aging, denial/overturn trends, dollars recovered. Consumes events; never on the OLTP write path.

Owns its own tables, services, and repository. Communicates with other modules **only** via domain events (see `../../docs/MODULE-BOUNDARIES.md`). Implementation lands in the phase noted in the merge assessment.
