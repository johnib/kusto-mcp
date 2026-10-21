# [1.19.0](https://github.com/johnib/kusto-mcp/compare/v1.18.3...v1.19.0) (2026-10-21)


### Bug Fixes

* handle empty and oversized query results [skip ci] ([#373](https://github.com/johnib/kusto-mcp/issues/373)) ([ffbaaa9](https://github.com/johnib/kusto-mcp/commit/ffbaaa96611a4157636d13ff505971a5fd80e8d3))
* sharpen execute-query guidance and purpose labels ([#371](https://github.com/johnib/kusto-mcp/issues/371)) ([b5a3607](https://github.com/johnib/kusto-mcp/commit/b5a3607f477891ad9885b73252dca95914295dbf))
* steer agents to connect before querying [skip ci] ([#372](https://github.com/johnib/kusto-mcp/issues/372)) ([415a63c](https://github.com/johnib/kusto-mcp/commit/415a63c8ae05842b839913821eda52ea2b77ff7a))


### Features

* **telemetry:** classify query failures and retries [skip ci] ([#374](https://github.com/johnib/kusto-mcp/issues/374)) ([982dcce](https://github.com/johnib/kusto-mcp/commit/982dcced8289122e84a8e8f11f02c99b35bce2e3))
* **telemetry:** measure session length, time range and target switches ([#375](https://github.com/johnib/kusto-mcp/issues/375)) ([6747fa9](https://github.com/johnib/kusto-mcp/commit/6747fa93a69cace20d4155c875bca395633ea1fc))

## [1.18.3](https://github.com/johnib/kusto-mcp/compare/v1.18.2...v1.18.3) (2026-10-17)


### Bug Fixes

* report client-disconnect EPIPE exits apart from real crashes ([#368](https://github.com/johnib/kusto-mcp/issues/368)) [skip ci] ([2541d0e](https://github.com/johnib/kusto-mcp/commit/2541d0e409043b4e7b6cc509b48a0dadd8647656)), closes [#365](https://github.com/johnib/kusto-mcp/issues/365)
* stop counting client-cancelled queries as tool errors ([#367](https://github.com/johnib/kusto-mcp/issues/367)) ([dc081b7](https://github.com/johnib/kusto-mcp/commit/dc081b7ef7b2efd50a20889f9e3c923e65a6fe15)), closes [#313](https://github.com/johnib/kusto-mcp/issues/313) [#366](https://github.com/johnib/kusto-mcp/issues/366)

## [1.18.2](https://github.com/johnib/kusto-mcp/compare/v1.18.1...v1.18.2) (2026-10-12)


### Bug Fixes

* ask az for the organizations tenant again for azure-cli auth ([#351](https://github.com/johnib/kusto-mcp/issues/351)) ([3e5a5bf](https://github.com/johnib/kusto-mcp/commit/3e5a5bf124b2552ffad2afbaf8109b039216ff46)), closes [#350](https://github.com/johnib/kusto-mcp/issues/350)
* classify failed default-chain sign-ins by the real cause, not the first step ([#352](https://github.com/johnib/kusto-mcp/issues/352)) [skip ci] ([7fa7845](https://github.com/johnib/kusto-mcp/commit/7fa7845036b79da3a97d3b4ae64e747fd3cf692e))

## [1.18.1](https://github.com/johnib/kusto-mcp/compare/v1.18.0...v1.18.1) (2026-10-11)


### Bug Fixes

* cache Azure tokens instead of spawning az on every query ([#344](https://github.com/johnib/kusto-mcp/issues/344)) [skip ci] ([3e27a85](https://github.com/johnib/kusto-mcp/commit/3e27a8525058468065f412171bf22c84511ef205)), closes [#296](https://github.com/johnib/kusto-mcp/issues/296)
* keep the working connection when a connect fails, and share concurrent connects ([#343](https://github.com/johnib/kusto-mcp/issues/343)) [skip ci] ([c898490](https://github.com/johnib/kusto-mcp/commit/c8984907f9a5ffefa94af344b63376c2ebb0bba9)), closes [#290](https://github.com/johnib/kusto-mcp/issues/290)
* kill the whole az process tree on timeout or cancel, for azure-cli and the default chain ([#348](https://github.com/johnib/kusto-mcp/issues/348)) ([7e449d1](https://github.com/johnib/kusto-mcp/commit/7e449d13971bb511289825d5957fbcc962f1786d)), closes [#346](https://github.com/johnib/kusto-mcp/issues/346) [#293](https://github.com/johnib/kusto-mcp/issues/293)
* stop abandoned connects and time-limit az ([#345](https://github.com/johnib/kusto-mcp/issues/345)) [skip ci] ([50ceb13](https://github.com/johnib/kusto-mcp/commit/50ceb132526fbe3f118a3660500c1f30a70603a6)), closes [#293](https://github.com/johnib/kusto-mcp/issues/293)

# [1.18.0](https://github.com/johnib/kusto-mcp/compare/v1.17.0...v1.18.0) (2026-10-11)


### Bug Fixes

* back off startup auto-connect across relaunches ([#338](https://github.com/johnib/kusto-mcp/issues/338)) [skip ci] ([07b3309](https://github.com/johnib/kusto-mcp/commit/07b33098577edd7e75117cec575162052a22d9a0)), closes [#316](https://github.com/johnib/kusto-mcp/issues/316)
* cancel running Kusto queries when the stdio client disconnects ([#340](https://github.com/johnib/kusto-mcp/issues/340)) ([88eadba](https://github.com/johnib/kusto-mcp/commit/88eadbaddb8dc672f92ef01047d86ede380de658)), closes [#333](https://github.com/johnib/kusto-mcp/issues/333)
* keep session and shape telemetry on invalid execute-query args ([#336](https://github.com/johnib/kusto-mcp/issues/336)) [skip ci] ([189ad79](https://github.com/johnib/kusto-mcp/commit/189ad7973db1cf09085a7e12718649ef9a135a46)), closes [#318](https://github.com/johnib/kusto-mcp/issues/318)


### Features

* say which connect step failed and how to fix it ([#339](https://github.com/johnib/kusto-mcp/issues/339)) [skip ci] ([07301bf](https://github.com/johnib/kusto-mcp/commit/07301bfce398a2096c4f8a889894299692fa7319)), closes [#315](https://github.com/johnib/kusto-mcp/issues/315)

# [1.17.0](https://github.com/johnib/kusto-mcp/compare/v1.16.0...v1.17.0) (2026-10-11)


### Bug Fixes

* wait for the startup auto-connect before failing tool calls ([#327](https://github.com/johnib/kusto-mcp/issues/327)) ([d7f92af](https://github.com/johnib/kusto-mcp/commit/d7f92af0b378b556952ab1c5f72d6d1bedcb2593)), closes [#311](https://github.com/johnib/kusto-mcp/issues/311)


### Features

* hint the agent after several failed queries in a row ([#326](https://github.com/johnib/kusto-mcp/issues/326)) [skip ci] ([aa2196f](https://github.com/johnib/kusto-mcp/commit/aa2196fcfee0e01cda7e638b3af7f9a849ba5313)), closes [#313](https://github.com/johnib/kusto-mcp/issues/313)
* raise default query timeout to 120s and send progress while queries run ([#334](https://github.com/johnib/kusto-mcp/issues/334)) [skip ci] ([8d44b19](https://github.com/johnib/kusto-mcp/commit/8d44b19ac9a056d7471426b6a74c3e49d371e8ad)), closes [#321](https://github.com/johnib/kusto-mcp/issues/321)

# [1.16.0](https://github.com/johnib/kusto-mcp/compare/v1.15.0...v1.16.0) (2026-10-11)


### Bug Fixes

* classify query timeouts by type, not error text ([#330](https://github.com/johnib/kusto-mcp/issues/330)) [skip ci] ([08ccbc9](https://github.com/johnib/kusto-mcp/commit/08ccbc9f1a0dc90ef41fe75a32bea46989aafa41)), closes [#319](https://github.com/johnib/kusto-mcp/issues/319)
* report all detected query operator families ([#325](https://github.com/johnib/kusto-mcp/issues/325)) [skip ci] ([1be48e3](https://github.com/johnib/kusto-mcp/commit/1be48e396bbe9247ca2c6d0c282ddd3cd6e5c023)), closes [#317](https://github.com/johnib/kusto-mcp/issues/317)
* send KUSTO_QUERY_TIMEOUT to the server as servertimeout ([#328](https://github.com/johnib/kusto-mcp/issues/328)) [skip ci] ([3770ead](https://github.com/johnib/kusto-mcp/commit/3770ead9e8722b59603b64be7d6980947ae510ca)), closes [#294](https://github.com/johnib/kusto-mcp/issues/294)


### Features

* cancel the Kusto query when the client cancels the tool call ([#331](https://github.com/johnib/kusto-mcp/issues/331)) [skip ci] ([c5d0d22](https://github.com/johnib/kusto-mcp/commit/c5d0d228268dd930e63ed138cd3a3b79a3e15251)), closes [#320](https://github.com/johnib/kusto-mcp/issues/320)
* suggest show-table before querying an unfamiliar table ([#324](https://github.com/johnib/kusto-mcp/issues/324)) [skip ci] ([e775392](https://github.com/johnib/kusto-mcp/commit/e7753921ce353f4977e5ea1d78e0a4f41d098588)), closes [#314](https://github.com/johnib/kusto-mcp/issues/314)
* tell the agent how to recover from a query timeout ([#332](https://github.com/johnib/kusto-mcp/issues/332)) ([831cbfa](https://github.com/johnib/kusto-mcp/commit/831cbfab899eb76792665da58d931f5011369e56)), closes [#312](https://github.com/johnib/kusto-mcp/issues/312)

# [1.15.0](https://github.com/johnib/kusto-mcp/compare/v1.14.3...v1.15.0) (2026-10-06)


### Features

* add query intent, shape and session telemetry ([#303](https://github.com/johnib/kusto-mcp/issues/303)) ([9b4d8f1](https://github.com/johnib/kusto-mcp/commit/9b4d8f1211d5659581ab20ac9c28eab6cd6fbffe))

## [1.14.3](https://github.com/johnib/kusto-mcp/compare/v1.14.2...v1.14.3) (2026-09-26)


### Bug Fixes

* escape pipes in markdown table cells ([#284](https://github.com/johnib/kusto-mcp/issues/284)) ([f4e87c6](https://github.com/johnib/kusto-mcp/commit/f4e87c622b12eda5b608f13f72081f8751ab30a9)), closes [#282](https://github.com/johnib/kusto-mcp/issues/282)

## [1.14.2](https://github.com/johnib/kusto-mcp/compare/v1.14.1...v1.14.2) (2026-09-26)


### Bug Fixes

* start the server when prompts are disabled ([#283](https://github.com/johnib/kusto-mcp/issues/283)) ([82e75cc](https://github.com/johnib/kusto-mcp/commit/82e75cc47b4449d88fd259fa0aced16f18bbdc2f))

## [1.14.1](https://github.com/johnib/kusto-mcp/compare/v1.14.0...v1.14.1) (2026-09-26)


### Bug Fixes

* **deps:** resolve npm audit findings, refresh in-range deps, prune stale overrides ([#280](https://github.com/johnib/kusto-mcp/issues/280)) ([5ca4c3b](https://github.com/johnib/kusto-mcp/commit/5ca4c3b91eba63c3f189522cc4f3aeef4d930e35))

# [1.14.0](https://github.com/johnib/kusto-mcp/compare/v1.13.2...v1.14.0) (2026-08-07)


### Features

* **telemetry:** record uncaught exceptions and unhandled rejections ([#217](https://github.com/johnib/kusto-mcp/issues/217)) ([7d0be88](https://github.com/johnib/kusto-mcp/commit/7d0be88596afa79050040b3dd2d080eca578d659)), closes [#180](https://github.com/johnib/kusto-mcp/issues/180) [#196](https://github.com/johnib/kusto-mcp/issues/196)

## [1.13.2](https://github.com/johnib/kusto-mcp/compare/v1.13.1...v1.13.2) (2026-08-07)


### Bug Fixes

* exit instead of spinning at 100% CPU when the MCP client dies ([#210](https://github.com/johnib/kusto-mcp/issues/210)) ([5394868](https://github.com/johnib/kusto-mcp/commit/53948683fd70bc176449b1f24cd9adff3ddbb8ca)), closes [#196](https://github.com/johnib/kusto-mcp/issues/196) [#180](https://github.com/johnib/kusto-mcp/issues/180)

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
