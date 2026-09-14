# Enterprise REST conversion corpus

Research date: 2026-09-14.

This expansion covers the requested enterprise applications and adjacent systems
used in financial services, retail and manufacturing. It contains 38 downloaded
contracts plus 13 explicit tenant-or-release export requirements. Contracts are
complete at their selected module/version; this is not a claim of whole-vendor
coverage. The [catalog](../../tools/corpus/enterprise/catalog.json) records every
source, scope and publisher. The [runner guide](../../tools/corpus/enterprise/README.md)
contains replay commands and the exact checks.

The completed sweep acquired all 38 public contracts: **30 passed static
conversion checks, four were policy-blocked, and four had conversion errors**.
The 13 remaining catalog entries require exports. Emitted AIR contains 9,329
operations in total, including diagnostic-bearing bundles; the 30 passing
contracts contain 5,967 operations. Passing conversion does not mean every
operation is eligible for execution: blocked and review-required states remain
recorded, and the raw lane approves zero operations.

## Selection rationale

The selection prioritizes integration value and protocol diversity. It is a
practical enterprise shortlist, not a numerical market-share ranking. Vendor
documentation establishes product scope and industry relevance; it does not
establish comparative adoption. ERP, procurement, HCM, productivity, identity,
payments, commerce and operations provide distinct conversion challenges.

| Sector | Integration priorities | Applications in this research |
|---|---|---|
| Financial services | Customer and employee records, payment/account data, identity, approvals and document workflows | Microsoft Graph, Google Workspace, Workday, Oracle HCM, Salesforce CRM, ServiceNow, Plaid, Stripe, Adyen, Okta, DocuSign, SAP Ariba |
| Retail | Shopper orders and customers, payments, locations, procurement, finance and workforce | Salesforce Commerce, BigCommerce, Shopware, Stripe, Adyen, Google Places, SAP Ariba, NetSuite, Workday, Samsara, Xero |
| Manufacturing | Supplier and business-partner data, ERP, workforce, operational assets and product lifecycle | SAP S/4HANA/BTP/SuccessFactors/Ariba, Oracle EBS/HCM, Workday, Infor, Samsara, ServiceNow, Teamcenter, Windchill |
| Shared enterprise services | Collaboration, documents, content, sales operations and design | Microsoft Graph, Google Workspace, Slack, Jira, Confluence, Box, HubSpot, Canva |
| Education and workforce learning | Courses, rosters, assignments and enabled LMS functions | Google Classroom, Moodle |

The sector grouping is an engineering prioritization. Plaid's
[institution coverage documentation](https://plaid.com/docs/institutions/)
supports its financial-data role. Workday describes retail finance, HR and
planning in its [retail offering](https://www.workday.com/en-us/solutions/industries/retail.html).
ServiceNow documents manufacturing customer service, asset and operational
workflows in its [manufacturing offering](https://www.servicenow.com/industries/manufacturing.html).
Samsara reports retail logistics customers in its
[retail customer announcement](https://www.samsara.com/company/news/press-releases/Thousands-of-Retail-Leaders-Standardize-on-Samsara).
These sources support including those workflow families; they are not an
independent ranking of SaaS vendors.

## Acquired scope and provenance

| Application family | Actual downloaded contract | Publisher and qualification |
|---|---|---|
| Microsoft | Graph Mail, Users, Teams, Calendar and Files v1.0 modules | [Microsoft Graph SDK](https://github.com/microsoftgraph/msgraph-sdk-powershell/tree/dev/openApiDocs/v1.0); five whole modules, not the full Graph estate |
| Google Workspace | Gmail, Drive, Docs, Sheets, Slides, Calendar, Admin Directory | [Google Discovery artifacts](https://github.com/googleapis/discovery-artifact-manager/tree/master/discoveries); REST discovery contracts |
| Google education and maps | Classroom v1 and Places v1 | Same official repository; Places does not stand for every Google Maps API |
| SAP SuccessFactors | User OData metadata | [SAP sample application](https://github.com/SAP/task-management-sample-app-sfsf-solutions); a vendor sample export, not all employee-central services |
| SAP S/4HANA | Business Partner OData metadata | [SAP Cloud SDK sample](https://github.com/SAP-samples/cloud-sdk-js); one business service |
| SAP BTP | Destination Service and AI Core | [SAP Python SDK](https://github.com/SAP/cloud-sdk-python) and [SAP AI SDK](https://github.com/SAP/ai-sdk-js) definitions |
| SAP Ariba | Supplier Data with Pagination and Document Approval | Historical [Informatica connector exports](https://github.com/InformaticaCloudApplicationIntegration/Service-Connectors); labeled as third-party published exports |
| Workday | Common v1, including workers and supervisory organizations | [Rapid7 reference export](https://github.com/rapid7/r7-surcom-connectors/tree/cc84ab48722310b3e3182f35ae6c4937597547a3/connectors/rapid7/workday/refdocs); README identifies Workday's REST documentation as its source; tenant host is a placeholder |
| Salesforce | Commerce Shopper Orders and Shopper Customers | [Salesforce Commerce SDK](https://github.com/SalesforceCommerceCloud/commerce-sdk); not Sales/Service Cloud sObjects |
| Atlassian | Jira Cloud v3 and Confluence Cloud v1 | Historical Informatica exports; these do not establish current Atlassian API completeness |
| Slack | Web API Swagger | [Slack's archived spec repository](https://github.com/slackapi/slack-api-specs); archived scope is explicit |
| Canva | Connect API | [Canva starter kit OpenAPI](https://github.com/canva-sdks/canva-connect-api-starter-kit) |
| Additional enterprise contracts | Stripe, Plaid, Adyen Checkout, DocuSign eSignature, Okta, Shopware, BigCommerce Orders, Xero Accounting, Box, HubSpot Deals, Samsara | Publisher repository, revision, file and exact byte identity are recorded per entry in the catalog |

Mutable repository links above aid discovery. Reproduction uses the immutable
commit URLs and Git blob IDs in the catalog and the SHA-256 identities in
[`sources.lock.json`](../../tools/corpus/enterprise/sources.lock.json).
Public availability does not imply that a historical contract is current.
The Workday export documents permissions in prose but omits machine-readable
authentication. Its conversion result does not validate an authenticated tenant
connection; that gap must be supplied and reviewed before deployment.

## Export requirements

These entries remain visible as `needs-export` until an actual contract is
supplied. They are not passing tests. The catalog provides official documentation
links and application-specific export instructions.

| Application | Contract needed to extend coverage |
|---|---|
| Workday HCM | Selected Staffing, Person or Absence service and version; include tenant extensions separately from Common v1 |
| Oracle Fusion HCM | Release-specific published Swagger or supported tenant describe export; distinguish release scope from flexfields |
| Oracle E-Business Suite | Deployed Integrated SOA Gateway service contract; WADL needs an adapter or a reviewed OpenAPI/Postman export |
| NetSuite REST | Account record metadata catalog, including enabled features and custom records; prior SOAP testing is separate |
| Moodle | Enabled external functions and installed-plugin schemas; a generic REST dispatch endpoint does not prove function coverage |
| Dynamics 365 / Dataverse | Tenant OData metadata, including custom tables |
| Business Central | Environment API metadata and extension APIs |
| Salesforce CRM | Org-specific REST or Postman export with relevant sObject/custom-object descriptions |
| ServiceNow | Instance REST API Explorer export for selected tables, plugins and query constraints |
| Siemens Teamcenter X | Licensed deployment REST contract with modules/version identified |
| PTC Windchill | Selected WRS domain OData metadata, with custom domains separately identified |
| Infor CloudSuite | Authorized ION API suite Swagger and its edition/version |
| Coupa | Reviewed Core API resource contracts and tenant custom fields |

This is a record of the acquisitions completed in this run. It is not a claim
that every missing vendor lacks any public definition. No fabricated demo
schema was used to fill a coverage gap.

## Conversion findings

The expanded contracts exposed and now exercise these compiler changes:

1. **Request-body collisions:** a scalar body field that normalizes to a path,
   query or other body input name now keeps the whole request-body envelope.
   Wire keys are retained. A parameter named `body` that would collide with the
   envelope is explicitly rejected. No write is approved by this transformation.
2. **HTTP method loss:** normalization now uses AIR's supported HTTP method
   enumeration, retaining Box's OPTIONS operations that were previously dropped.
3. **Google Discovery completeness:** document-level methods and common
   parameters are retained; declared scalar defaults receive their scalar type.
   OAuth credential query carriers are excluded from ordinary agent inputs when
   the document uses OAuth.
4. **Ambiguous Discovery templates:** distinct methods sharing the same verb
   and reserved-resource path now produce `discovery_endpoint_collision` instead
   of silently overwriting one another. Google Admin Directory and Places expose
   this remaining adapter limitation. Full support needs distinct resource
   bindings; the current change diagnoses loss rather than inventing routes.
5. **DocuSign serialization:** the AIR YAML fallback emits JSON-compatible
   double-quoted strings so descriptions with whitespace-only lines retain their
   bytes through the YAML round-trip.

Microsoft Graph Teams and DocuSign also contain distinct wire parameters that
collapse to one agent input name. DocuSign's YAML serialization now completes,
revealing a path/query `langCode` collision that still prevents a clean full
conversion. These cases require a reviewed binding/naming solution. Free-form
query-language operations in Jira, Confluence, Okta and Xero retain their policy
gate; generic query text is not approved to improve conversion statistics.

The checked-in [conversion results](enterprise-results.md) and
[reviewed read results](enterprise-smoke-results.md) record the measured outcomes.
Static conversion and loopback samples do not certify upstream authorization,
business semantics, tenant configuration or production deployment. The raw lane
approves no operations and makes no vendor API calls.

## Validation

The workspace build and typecheck completed successfully. The full workspace
suite passed 4,700 tests across 336 test files, with 32 tests skipped. Seven
additional acquisition/accounting tests passed separately. Lint and dead-code
checks passed; the AIR serialization regression also passed after strengthening
its whitespace fixture. Runtime sample results are recorded separately, with
the number of executed and skipped checks preserved in the JSON report.
