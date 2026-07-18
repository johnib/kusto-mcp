## [1.13.1](https://github.com/johnib/kusto-mcp/compare/v1.13.0...v1.13.1) (2026-07-18)


### Bug Fixes

* **ci:** repair [@claude](https://github.com/claude) workflow auth and restrict trigger to owner ([#175](https://github.com/johnib/kusto-mcp/issues/175)) ([685ed4d](https://github.com/johnib/kusto-mcp/commit/685ed4d04280576727421571ea330d0fa6bbe2b8))

# [1.13.0](https://github.com/johnib/kusto-mcp/compare/v1.12.0...v1.13.0) (2026-07-05)


### Features

* add report-issue tool for filing GitHub issues via pre-filled URL ([#162](https://github.com/johnib/kusto-mcp/issues/162)) ([feb460b](https://github.com/johnib/kusto-mcp/commit/feb460bdd71692d6bace3abf156e019ee3446938))

# [1.12.0](https://github.com/johnib/kusto-mcp/compare/v1.11.0...v1.12.0) (2026-07-04)


### Features

* anonymity-preserving connection/auth diagnostics + connection timeout ([#161](https://github.com/johnib/kusto-mcp/issues/161)) ([8f1b93d](https://github.com/johnib/kusto-mcp/commit/8f1b93dc3d3c99b30502a6d871a43a081d91c0fe))

# [1.11.0](https://github.com/johnib/kusto-mcp/compare/v1.10.3...v1.11.0) (2026-07-03)


### Features

* always-on anonymous usage telemetry ([#152](https://github.com/johnib/kusto-mcp/issues/152)) ([9120b61](https://github.com/johnib/kusto-mcp/commit/9120b61eec8b3d816de49d2aed26a26465ee2ab5))

## [1.10.3](https://github.com/johnib/kusto-mcp/compare/v1.10.2...v1.10.3) (2026-07-03)


### Bug Fixes

* correct reviewer creds (ANTHROPIC_API_KEY), job-level base_url, pin opus-4-8 ([3cfe0c0](https://github.com/johnib/kusto-mcp/commit/3cfe0c024740c0c347490d0fb5a2b0bd3f45dbc9))

## [1.10.2](https://github.com/johnib/kusto-mcp/compare/v1.10.1...v1.10.2) (2026-06-19)


### Bug Fixes

* harden query safety, fix lint coverage, and clean up security debt ([#146](https://github.com/johnib/kusto-mcp/issues/146)) ([5e29b7c](https://github.com/johnib/kusto-mcp/commit/5e29b7ce5e17cc8380b6d09dfa5f5c701d72b2ae))

## [1.10.1](https://github.com/johnib/kusto-mcp/compare/v1.10.0...v1.10.1) (2026-03-28)


### Bug Fixes

* remove dotenv to prevent stdout pollution breaking MCP stdio transport ([#41](https://github.com/johnib/kusto-mcp/issues/41)) ([3374328](https://github.com/johnib/kusto-mcp/commit/3374328ec060f38a65ee3eb76387eec10da07f12))
* use PAT in release workflow to bypass branch protection ([#42](https://github.com/johnib/kusto-mcp/issues/42)) ([a8bb1eb](https://github.com/johnib/kusto-mcp/commit/a8bb1ebb5bd3f34bc5287473c9ce223b54c981a0))

# [1.10.0](https://github.com/johnib/kusto-mcp/compare/v1.9.2...v1.10.0) (2026-03-06)


### Bug Fixes

* update CI node version for semantic-release v25 compatibility ([05ac006](https://github.com/johnib/kusto-mcp/commit/05ac00645da8a7ad6bbbd08f5f91572d484dce0e))
* update dependencies to address security vulnerabilities ([fba28e7](https://github.com/johnib/kusto-mcp/commit/fba28e7c6a17395cb4f4066b064e5740a98e6dc1))
* update dependency overrides to address security vulnerabilities ([a631f7d](https://github.com/johnib/kusto-mcp/commit/a631f7d842abddc71e82b37f09c2f1d45dbca745))


### Features

* upgrade all dependencies to latest major versions ([ba6c9a3](https://github.com/johnib/kusto-mcp/commit/ba6c9a370155aae182d37b7bc10a09bd19701d91)), closes [#29](https://github.com/johnib/kusto-mcp/issues/29)

## [1.9.2](https://github.com/johnib/kusto-mcp/compare/v1.9.1...v1.9.2) (2025-12-23)


### Bug Fixes

* update dependencies and fix e2e test issues ([f812248](https://github.com/johnib/kusto-mcp/commit/f812248233a3ff6bf991fed82691f1f3479db22b))

## [1.9.1](https://github.com/johnib/kusto-mcp/compare/v1.9.0...v1.9.1) (2025-11-26)


### Bug Fixes

* update dependencies to address security vulnerabilities ([b46c6d9](https://github.com/johnib/kusto-mcp/commit/b46c6d90ba5de678a2adce8a99d53baac1753a5b))

# [1.9.0](https://github.com/johnib/kusto-mcp/compare/v1.8.1...v1.9.0) (2025-10-31)


### Features

* configure Claude Code action with custom endpoint support ([9a9c03c](https://github.com/johnib/kusto-mcp/commit/9a9c03c0e163b005a74352c481795fe5d583a89e))

## [1.8.1](https://github.com/johnib/kusto-mcp/compare/v1.8.0...v1.8.1) (2025-10-31)


### Bug Fixes

* update claude workflow to use standard ANTHROPIC_API_KEY secret ([b5024b5](https://github.com/johnib/kusto-mcp/commit/b5024b53b0b60e54b4e69d7ad3f676ad1cfd78d9))

# [1.8.0](https://github.com/johnib/kusto-mcp/compare/v1.7.0...v1.8.0) (2025-10-31)


### Features

* enhance Claude Code workflow with additional environment variables for improved functionality ([09ed243](https://github.com/johnib/kusto-mcp/commit/09ed24394260db34fa787fb385d4f0defe9b1ed2))

# [1.7.0](https://github.com/johnib/kusto-mcp/compare/v1.6.1...v1.7.0) (2025-10-17)


### Features

* add MCP prompts support with query performance analysis prompt ([#14](https://github.com/johnib/kusto-mcp/issues/14)) ([37f003b](https://github.com/johnib/kusto-mcp/commit/37f003bc16c53abc8bd6bc51162016e24c767b36))

## [1.6.1](https://github.com/johnib/kusto-mcp/compare/v1.6.0...v1.6.1) (2025-09-25)


### Bug Fixes

* preserve detailed Kusto error messages instead of generic HTTP status codes ([36e0b20](https://github.com/johnib/kusto-mcp/commit/36e0b205bbfd7895db06c9421dc11360fecc7ae6))

# [1.6.0](https://github.com/johnib/kusto-mcp/compare/v1.5.0...v1.6.0) (2025-09-17)


### Features

* add MCP test client script for feature testing during development ([24f5b80](https://github.com/johnib/kusto-mcp/commit/24f5b802237579de316aacecea7b4f0e9a66ac83))
* add query statistics extraction and configuration option ([a75bbf9](https://github.com/johnib/kusto-mcp/commit/a75bbf9e36c7335b143354708c66e4289f1571dc))

# [1.5.0](https://github.com/johnib/kusto-mcp/compare/v1.4.2...v1.5.0) (2025-09-17)


### Features

* add auto-connection functionality for MCP server startup ([760bd79](https://github.com/johnib/kusto-mcp/commit/760bd796f3d5baab0f4feb991f6d5507733681e0))

## [1.4.2](https://github.com/johnib/kusto-mcp/compare/v1.4.1...v1.4.2) (2025-06-24)


### Bug Fixes

* Simplify Kusto connection validation and update test configuration ([5658759](https://github.com/johnib/kusto-mcp/commit/5658759426cae6de5c68d62bac3b8f78598d4889))

## [1.4.1](https://github.com/johnib/kusto-mcp/compare/v1.4.0...v1.4.1) (2025-06-19)


### Bug Fixes

* Improve markdown formatter object handling with JSON serialization ([d41e558](https://github.com/johnib/kusto-mcp/commit/d41e558aa79b7a902380a17381a83d960c785182))

# [1.4.0](https://github.com/johnib/kusto-mcp/compare/v1.3.0...v1.4.0) (2025-06-06)


### Features

* add pre-commit hooks with Husky and lint-staged ([61a2379](https://github.com/johnib/kusto-mcp/commit/61a2379a84ec4bc1a622c7fa8dc8baa24293b462))

# [1.3.0](https://github.com/johnib/kusto-mcp/compare/v1.2.0...v1.3.0) (2025-06-06)


### Features

* Add configurable markdown table cell truncation ([a9f8de1](https://github.com/johnib/kusto-mcp/commit/a9f8de179b41cf734f0b0e23024182df3b1c5bcd))
* Add global response size limiting with intelligent row reduction ([a3d6a4e](https://github.com/johnib/kusto-mcp/commit/a3d6a4ee9afcc68fd4f37e1cf2280d65d2fa3620))

# [1.2.0](https://github.com/johnib/kusto-mcp/compare/v1.1.1...v1.2.0) (2025-06-06)


### Bug Fixes

* Update CI workflow to ignore pushes to main and master branches ([3a66931](https://github.com/johnib/kusto-mcp/commit/3a66931d949482df9ed38dceae90325827405751))


### Features

* Add markdown response format support for Kusto queries ([a5f5cfc](https://github.com/johnib/kusto-mcp/commit/a5f5cfcb4bc48e5c7465f4cc53fa4c25e25f83e5))
