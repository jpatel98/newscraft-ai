# Performance Goal Prompt

```text
/goal Comprehensively improve this codebase's performance, responsiveness, and perceived speed across the full user experience.

Act as a senior performance engineer. Do not guess. First establish a clear baseline, then identify bottlenecks, then make focused improvements, then verify the impact.

Scope to investigate:
- Initial load time
- Time to interactive
- Largest Contentful Paint
- Cumulative Layout Shift
- Interaction latency
- Route transitions
- Frontend rendering performance
- React component re-render frequency
- Bundle size and code splitting
- Asset loading and image optimization
- CSS size and runtime styling cost
- API request waterfalls
- Server/API response latency
- Database query performance
- Caching strategy
- Auth/session lookup cost
- Startup time
- Build time
- Memory usage
- Any repeated polling, timers, subscriptions, or background work
- Any expensive synchronous work on the main thread
- Any unnecessary network requests
- Any work done repeatedly that could be memoized, cached, batched, deferred, or moved server-side

Workflow:

1. Inspect the repository structure, package scripts, framework, routing model, data layer, deployment assumptions, and existing test/build tooling.

2. Run the app locally if possible. Identify how to start it, what routes or workflows matter most, and what commands are available for build, test, lint, typecheck, and performance inspection.

3. Establish a baseline before making changes. Use the best available project-appropriate measurements, such as:
   - production build output,
   - bundle analysis,
   - browser performance traces,
   - Lighthouse-style checks,
   - Playwright timing checks,
   - server logs,
   - API timing measurements,
   - database query timing,
   - custom lightweight instrumentation,
   - or manual timing where tooling is limited.

4. Identify the highest-impact bottlenecks. Prioritize issues by likely user-visible impact, confidence, and implementation risk.

5. Improve frontend performance where applicable:
   - reduce unnecessary client-side rendering,
   - avoid avoidable React re-renders,
   - add memoization only where it has a clear benefit,
   - stabilize props and callbacks where useful,
   - split large components if it reduces rendering cost,
   - defer non-critical work,
   - lazy-load heavy routes or components,
   - reduce unnecessary effects,
   - prevent duplicate fetches,
   - eliminate request waterfalls,
   - improve loading states,
   - avoid layout shifts,
   - optimize images, fonts, and static assets,
   - reduce JavaScript shipped to the client,
   - remove unused dependencies or imports,
   - ensure expensive calculations are not repeated during render.

6. Improve backend/API performance where applicable:
   - find slow endpoints,
   - reduce duplicate work,
   - batch or parallelize independent I/O safely,
   - avoid unnecessary serialization or transformations,
   - add caching where correct,
   - use proper cache invalidation,
   - remove blocking synchronous operations from hot paths,
   - improve pagination or limits,
   - avoid returning excessive payloads,
   - ensure error handling remains correct.

7. Improve database performance where applicable:
   - inspect slow or repeated queries,
   - avoid N+1 query patterns,
   - select only needed columns,
   - add or adjust indexes only when justified,
   - improve query shape,
   - batch related queries where appropriate,
   - preserve data correctness,
   - avoid migrations that are risky without clear benefit.

8. Improve build/startup/developer performance where applicable:
   - inspect slow scripts,
   - reduce unnecessary work during startup,
   - improve dev-server startup where feasible,
   - avoid heavyweight imports in startup paths,
   - keep changes compatible with the project's package manager and tooling.

9. Keep implementation disciplined:
   - preserve existing behavior,
   - follow the project's existing architecture and style,
   - keep changes scoped and reviewable,
   - avoid speculative rewrites,
   - avoid adding large dependencies unless strongly justified,
   - do not degrade accessibility, correctness, security, or maintainability,
   - do not remove features to make metrics look better.

10. Add or update tests where performance changes could affect behavior. Prefer focused tests that protect the optimized paths.

11. Verify after changes:
   - rerun the baseline measurements where possible,
   - run build/typecheck/lint/tests as available,
   - run browser verification for key flows if this is a frontend app,
   - compare before/after results,
   - note any measurements that could not be taken and why.

12. Finish with a clear performance report containing:
   - baseline findings,
   - bottlenecks discovered,
   - files changed,
   - optimizations implemented,
   - before/after measurements where available,
   - verification commands run,
   - any tests added or updated,
   - behavior preserved,
   - remaining risks,
   - and the next highest-impact performance opportunities.
```
