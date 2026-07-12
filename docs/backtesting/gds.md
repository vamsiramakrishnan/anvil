# GDS systems — Amadeus, Travelport, Sabre (the SOAP/WSDL proving ground)

The travel GDS world is where SOAP still lives in production. Triage (every
URL verified by live fetch):

| System | Spec | Reference MCP | Verdict |
| --- | --- | --- | --- |
| Amadeus Self-Service | ✅ `amadeus4dev/amadeus-open-api-specification` — one Swagger 2.0 file per product | ⚠️ community only (`donghyun-chae/mcp-amadeus`, others) | **BACKTESTED** |
| Travelport uAPI | ✅ official Travelport GitHub org — 158 WSDLs, versions v26–v51, full XSD trees | ❌ none found | SPEC-ONLY; drove the multi-file WSDL mechanism |
| Sabre | ✅ SabreDevStudio — 30 real SOAP WSDLs | ⚠️ official Sabre MCP exists but is partner-gated | SPEC-ONLY |

## Amadeus Flight Offers Search v2 — clean compile, zero new findings

`FlightOffersSearch_v2` (Swagger 2.0, 83KB, 2 operations) through the full
loop: source add → compile → inspect → lint. Now corpus system #19
(`reproduce/systems.tsv`, baseline entry present).

- `GET /shopping/flight-offers` → `get_flight_offers` (read).
- `POST /shopping/flight-offers` → **`search_flight_offers`, classified
  read** — the search-on-POST rule (findings #2/#25) fires exactly as
  designed on a real POST-with-body search. The community MCP exposes this
  same call as `search_flights`; semantically the same name.
- Request schema is real and deep: `currencyCode`, `originDestinations`,
  `travelers`, `sources`, `searchCriteria`, with Amadeus's own field
  descriptions carried through.
- `auth: none` is **faithful to the source** — Amadeus's published spec
  declares no `securityDefinitions` at all (the live API actually requires
  OAuth2 client-credentials). That's a spec omission to be repaired by an
  Anvil manifest at enrichment time, not a compiler defect; it's also a good
  reminder that generated artifacts inherit the spec's honesty.

## Travelport uAPI Air v45_0 — the real multi-file WSDL tree

Fetched the complete Air service tree from Travelport's official GitHub
(8 files, ~985KB): `airSearch/{Air.wsdl, AirAbstract.wsdl, AirReqRsp.xsd,
Air.xsd}` plus `common_v45_0/{CommonReqRsp.xsd, Common.xsd}`,
`rail_v45_0/Rail.xsd`, `SessionContext_v1/SessionContext_v1.xsd` — a
`wsdl:import` + transitive `xsd:include`/`xsd:import` graph with relative
`../common_v45_0/...` paths. This is what production SOAP actually looks
like, and single-file WSDL support empirically fails on it:

- **`Air.wsdl` (the entry point) compiled to 0 operations** — its portType
  and messages live in the `wsdl:import`ed `AirAbstract.wsdl`.
- `AirAbstract.wsdl` alone yielded 29 operations but with opaque request
  schemas (unresolved XSD includes) and degraded names
  (`tp_air2 service create flight_details_port_type` — the portType name
  leaking into the naming signal).
- `anvil source add` refused `.xsd` supporting files outright
  (`source/unparseable` — the importer YAML-probed them).

This is the exact WSDL analogue of proto finding #22 (multi-file `.proto`
imports), and it got the same mechanism (findings #28–#29 in
`deficiencies.md`): snapshot-hermetic capture of the whole referenced tree
(`.xsd` files bypass the YAML probe like `.proto` does; an XML import walker
preserves relative directory structure) plus an injectable import resolver
threaded through `adaptWsdl` — `wsdl:import`, `xsd:include`, `xsd:import`,
transitive, cycle-safe, degrading gracefully on missing targets, with
`complexContent/extension` lowered to `allOf` and `element ref=` promoted to
component `$ref`s. No filesystem access inside `protocols/`.

**Result**: `anvil source add specs/tp && anvil compile --entrypoint
airSearch/Air.wsdl` → **29 operations** (was 0), real request schemas
assembled across three XSD files (AirLowFareSearch's body carries
`SearchPassenger`, `AirPricingModifiers`, `FlexExploreModifiers`, …), and the
safety layer reads the domain correctly with no manifest at all: all five
`*Search` operations classify as reads, ticketing/exchange/void as
review-required mutations, and `AirRefundQuote`/`AirRefundTicket` as
**financial-risk** mutations. The portType-name pollution is gone
(`air_service_air_low_fare_search`, not `…flight_details_port_type`), and the
synthetic `examples/soap/bank.wsdl` output stayed byte-identical.

Travelport stays SPEC-ONLY in the triage (no reference MCP exists to diff
tool surfaces against), and it is not in the quick corpus because the
reproduce recipe is one-URL-per-system — multi-file fetch support is the
natural extension if a second WSDL corpus system (Sabre) is added.

Sabre's 30 WSDLs are the natural second corpus datapoint for the same
mechanism; its official MCP being partner-gated keeps it SPEC-ONLY for
surface comparison.
