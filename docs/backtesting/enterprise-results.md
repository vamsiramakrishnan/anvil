# Enterprise API conversion corpus

Run: 2026-09-14T00:43:59.118Z. Base Git tree: `7dada19a75b9af4359e6aa0c2a23d313e27146f0`. Uncommitted changes: true.

Implementation SHA-256: `704e7769e9f124db4e3269b817581899ce1417a712fff3fd913e238c61b71c4d`.

51 contracts selected; 9329 operations in generated bundles.

pass: **30** · compile-failed: **4** · policy-blocked: **4** · needs-export: **13**

These results test downloaded contract conversion and generated artifacts. They do not certify a vendor tenant, production credentials, business semantics, or deployed Gemini Enterprise registration. No vendor API operations are invoked.

| Contract | Publisher / scope | Result | Operations | Approved / review / blocked | Checks failing |
|---|---|---|---:|---:|---|
| Google Workspace — Gmail | vendor | pass | 79 | 0 / 79 / 0 | — |
| Google Workspace — Drive | vendor | pass | 64 | 0 / 64 / 0 | — |
| Google Workspace — Docs | vendor | pass | 3 | 0 / 3 / 0 | — |
| Google Workspace — Sheets | vendor | pass | 17 | 0 / 17 / 0 | — |
| Google Workspace — Slides | vendor | pass | 5 | 0 / 5 / 0 | — |
| Google Workspace — Calendar | vendor | pass | 38 | 0 / 38 / 0 | — |
| Google Workspace — Admin Directory | vendor | compile-failed | 125 | 0 / 125 / 0 | source-coverage |
| Google Classroom | vendor | pass | 104 | 0 / 104 / 0 | — |
| Google Maps — Places | vendor | compile-failed | 4 | 0 / 4 / 0 | source-coverage |
| Microsoft Graph — mail | vendor-module | pass | 136 | 0 / 136 / 0 | — |
| Microsoft Graph — users | vendor-module | pass | 272 | 0 / 272 / 0 | — |
| Microsoft Graph — teams | vendor-module | compile-failed | 1421 | 0 / 1419 / 2 | duplicate_agent_input_name |
| Microsoft Graph — calendar | vendor-module | pass | 380 | 0 / 380 / 0 | — |
| Microsoft Graph — files | vendor-module | pass | 1619 | 0 / 1619 / 0 | — |
| Canva Connect | vendor | pass | 59 | 0 / 55 / 1 | — |
| Slack Web API | vendor-archived | pass | 174 | 0 / 174 / 0 | — |
| SAP SuccessFactors — User | vendor-sample-export | pass | 4 | 0 / 2 / 0 | — |
| SAP S/4HANA — Business Partner | vendor-sample-export | pass | 198 | 0 / 80 / 0 | — |
| SAP BTP — Destination Service | vendor | pass | 47 | 0 / 9 / 0 | — |
| SAP BTP — AI Core | vendor | pass | 89 | 0 / 25 / 0 | — |
| SAP Ariba — Supplier Data with Pagination | Informatica-export | pass | 12 | 0 / 2 / 0 | — |
| SAP Ariba — Document Approval | Informatica-export | pass | 7 | 0 / 1 / 0 | — |
| Atlassian Jira Cloud v3 — historical export | Informatica-export | policy-blocked | 316 | 0 / 50 / 2 | query_language_passthrough |
| Atlassian Confluence Cloud v1 — historical export | Informatica-export | policy-blocked | 113 | 0 / 21 / 2 | query_language_passthrough |
| Salesforce Commerce — Shopper Orders | vendor-module | pass | 13 | 0 / 0 / 13 | — |
| Salesforce Commerce — Shopper Customers | vendor-module | pass | 33 | 0 / 12 / 21 | — |
| Stripe | vendor | pass | 594 | 0 / 594 / 0 | — |
| Plaid | vendor | pass | 351 | 0 / 1 / 350 | — |
| Adyen Checkout v71 | vendor | pass | 28 | 0 / 28 / 0 | — |
| DocuSign eSignature | vendor | compile-failed | 414 | 0 / 65 / 1 | duplicate_agent_input_name |
| Okta Management | vendor | policy-blocked | 734 | 0 / 16 / 710 | query_language_passthrough |
| Shopware Admin | vendor | pass | 1117 | 0 / 0 / 1117 | — |
| BigCommerce Orders v2 | vendor | pass | 27 | 0 / 2 / 0 | — |
| Xero Accounting | vendor | policy-blocked | 235 | 0 / 215 / 20 | query_language_passthrough |
| Box | vendor | pass | 297 | 0 / 295 / 0 | — |
| HubSpot CRM — Deals | vendor-module | pass | 12 | 0 / 12 / 0 | — |
| Samsara Connected Operations | vendor | pass | 148 | 0 / 44 / 0 | — |
| Workday — Common v1 | Rapid7-export | pass | 40 | 0 / 4 / 0 | — |
| Workday HCM | tenant-or-release-export-required | needs-export | — | — | Export the selected Staffing/Person/Absence REST service OpenAPI from Workday REST API Explorer. Include its service version and tenant extensions. |
| Oracle Fusion HCM | tenant-or-release-export-required | needs-export | — | — | Download the release-specific HCM Swagger from the REST API guide, or export tenant /hcmRestApi/resources/<version>/describe with the OpenAPI media type when supported. The public release and tenant flexfields are different scopes. |
| Oracle E-Business Suite | tenant-or-release-export-required | needs-export | — | — | Export the deployed Integrated SOA Gateway REST service. EBS commonly describes REST using WADL, which Anvil does not accept. Supply an actual OpenAPI or reviewed Postman export; a WADL is an adapter gap, not a passing REST conversion. |
| Oracle NetSuite — REST records | tenant-or-release-export-required | needs-export | — | — | Export /services/rest/record/v1/metadata-catalog for the selected record types with application/swagger+json. The account's enabled features and custom records affect this contract. The existing SOAP backtest does not cover REST. |
| Moodle Workplace / LMS | tenant-or-release-export-required | needs-export | — | — | Export the site's enabled external functions and installed-plugin contracts as reviewed OpenAPI. Moodle core REST is a function-dispatch endpoint, not a vendor-wide OpenAPI. A generic /webservice/rest/server.php skeleton does not establish function coverage. |
| Microsoft Dynamics 365 / Dataverse | tenant-or-release-export-required | needs-export | — | — | Export the tenant Web API /api/data/v9.2/$metadata, including custom tables. OData reference services are not Dynamics coverage. |
| Microsoft Dynamics 365 Business Central | tenant-or-release-export-required | needs-export | — | — | Export /api/v2.0/$metadata for the selected environment and any extension APIs. |
| Salesforce CRM — sObjects and custom objects | tenant-or-release-export-required | needs-export | — | — | Export the reviewed org-specific REST contract or Postman collection, including /sobjects describes. Commerce Cloud contracts do not validate Sales/Service Cloud custom objects. |
| ServiceNow — ITSM / industry workflows | tenant-or-release-export-required | needs-export | — | — | Export OpenAPI from REST API Explorer for the instance, plugins and tables under test. Include table-specific fields and query constraints. |
| Siemens Teamcenter X | tenant-or-release-export-required | needs-export | — | — | Obtain the licensed deployment's REST API specification from its administrator. Capture version, modules and configuration. |
| PTC Windchill REST Services | tenant-or-release-export-required | needs-export | — | — | Export the selected WRS domain's OData $metadata, such as Product Management. Include custom domains separately. |
| Infor CloudSuite / ION API | tenant-or-release-export-required | needs-export | — | — | Export authorized API-suite Swagger from the tenant's ION API gateway. Record CloudSuite edition, suite and version. |
| Coupa Procurement | tenant-or-release-export-required | needs-export | — | — | Obtain a reviewed contract for the selected Core API resources and tenant custom fields. |

## Source provenance

| Contract | SHA-256 | Bytes | Source |
|---|---|---:|---|
| gmail | `7591d33ec87e4ef83551f71630213a89ac349becebe9bd9b3e4ce3851dede0fe` | 217686 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/gmail.v1.json) |
| google_drive | `08610b0a577bfe7508a69d810433c1b818d9ebfc033fa8dc1a3c738de080b062` | 269468 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/drive.v3.json) |
| google_docs | `bb61f4357de15dcea58e45d329d19a0ec56cd719127f6409b15927758dc043ab` | 236939 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/docs.v1.json) |
| google_sheets | `88c2374fe8dd9a58ad3b8cfaef7b0f5ced1418e625ea0ce1abef45c9deb448bd` | 377970 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/sheets.v4.json) |
| google_slides | `87e5e24eb6ed0bc1965055b77c0addbeb72275acf11f1f14cf23bf3e4ba8f25e` | 227919 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/slides.v1.json) |
| google_calendar | `99624ecfbe3a20d724a59c980dd391882d3a23ded23a74fcb18659aeb98a895e` | 169815 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/calendar.v3.json) |
| google_admin | `0141933ab2d43cd1a963a8b0de188eba02ca66fc1373bc7b850c8c0a1f92239a` | 386774 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/admin.directory_v1.json) |
| google_classroom | `f5e5da2fdae9b0cc86db126229784e8d52d7591149336d2013e268d44cbcef13` | 351137 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/classroom.v1.json) |
| google_places | `2353064e8ee8dc35c7b8220ead1c6bde9e37898e87087ee40f20949d7d8ee1f9` | 148499 | [source](https://raw.githubusercontent.com/googleapis/discovery-artifact-manager/4a575a58ada5884c295d604baa39465b7892b40b/discoveries/places.v1.json) |
| graph_mail | `503db1b9d86b8538d5424b53aae3a82d7e75f24051f76ad4258b99cc42a80496` | 279416 | [source](https://raw.githubusercontent.com/microsoftgraph/msgraph-sdk-powershell/11d2801bd3d9043c7b1d074f7442f98c2347aeaa/openApiDocs/v1.0/Mail.yml) |
| graph_users | `bb15744f533c0eb8901a4115b0d8a276eb0ac7eb2fa62fa66dadd1d2fd5a4804` | 1321974 | [source](https://raw.githubusercontent.com/microsoftgraph/msgraph-sdk-powershell/11d2801bd3d9043c7b1d074f7442f98c2347aeaa/openApiDocs/v1.0/Users.yml) |
| graph_teams | `ff15016ec2342472f22dc4c84fff093f9e4c01bbcdaf808973a6c22acfc9a581` | 3005278 | [source](https://raw.githubusercontent.com/microsoftgraph/msgraph-sdk-powershell/11d2801bd3d9043c7b1d074f7442f98c2347aeaa/openApiDocs/v1.0/Teams.yml) |
| graph_calendar | `677638330614554db8c313ac487b63af194d125320c7e668329e6cb5c1674805` | 700340 | [source](https://raw.githubusercontent.com/microsoftgraph/msgraph-sdk-powershell/11d2801bd3d9043c7b1d074f7442f98c2347aeaa/openApiDocs/v1.0/Calendar.yml) |
| graph_files | `d387990c3d4b519fb98630788591cfb5696595f51d0934080e8aacfe744767d6` | 3330809 | [source](https://raw.githubusercontent.com/microsoftgraph/msgraph-sdk-powershell/11d2801bd3d9043c7b1d074f7442f98c2347aeaa/openApiDocs/v1.0/Files.yml) |
| canva | `76649231b2f607cafe2076e0b866962e045c866db359fbf9b502afba9f7f67ee` | 437025 | [source](https://raw.githubusercontent.com/canva-sdks/canva-connect-api-starter-kit/f121e3d0736260962ae8445935bd370c61bb09d0/openapi/spec.yml) |
| slack | `742a5c977180a829df8767cf57bc417d99b3713583aee83741efb9c08ca731e7` | 1237332 | [source](https://raw.githubusercontent.com/slackapi/slack-api-specs/bc08db49625630e3585bf2f1322128ea04f2a7f3/web-api/slack_web_openapi_v2.json) |
| sap_successfactors | `8d5fe16c1552347ea17146eae89a2321b330a48160bebcddc8d1d62ef17cb901` | 55177 | [source](https://raw.githubusercontent.com/SAP/task-management-sample-app-sfsf-solutions/1a6fcf83abaee8a8045499dfb8fb1e89122c3080/task-management-app/edmx/User.edmx) |
| sap_s4hana | `c69ba6253a3efdeb1878fc6030001c10ed6dec84c8a2124e2f20790c595aecae` | 359549 | [source](https://raw.githubusercontent.com/SAP-samples/cloud-sdk-js/45804ef28874b32e93a3b95f0146aa841a701e82/samples/cds-sample-application/resources/service-specs/API_BUSINESS_PARTNER.edmx) |
| sap_btp | `ae1e77ad057fa0a1efa49f6eacd7b6c5bc00e28c34c85e32197c68b1664bea6e` | 237704 | [source](https://raw.githubusercontent.com/SAP/cloud-sdk-python/0ccb34bb4a9dd3019d4e46908e8c0e98058ec070/src/sap_cloud_sdk/destination/spec/api_spec.yaml) |
| sap_ai_core | `d47c3b229c8fb3d3db72f19829db54b4abcd99abc487118b67fd9be5f46b1dd2` | 246361 | [source](https://raw.githubusercontent.com/SAP/ai-sdk-js/2d0a51f8fb610ac7dc48052ce13468ac5dd7a52d/packages/ai-api/src/spec/AI_CORE_API.yaml) |
| sap_ariba | `8a926c163e74b5c471bc8ade61faae744bad4e2d6597f01080f02f65e8de2c23` | 82146 | [source](https://raw.githubusercontent.com/InformaticaCloudApplicationIntegration/Service-Connectors/fe7834cfc5234aab55bb08289aedee850eebe82a/SAP%20Ariba/SAP%20Ariba%20Supplier%20Data%20with%20Pagination%20REST%20API%20v2.json) |
| sap_ariba_approvals | `24c5addfc39f7633cfaa493d472396af4b67896ea8b5317fb6776ee8fad34566` | 46934 | [source](https://raw.githubusercontent.com/InformaticaCloudApplicationIntegration/Service-Connectors/fe7834cfc5234aab55bb08289aedee850eebe82a/SAP%20Ariba/SAP%20Ariba%20Document%20Approval%20REST%20API%20v1.json) |
| jira | `4a0f1e8a7948c473e6e3592f68dff5f00985e11d5b5d5379c303802e8f20bbfe` | 1255032 | [source](https://raw.githubusercontent.com/InformaticaCloudApplicationIntegration/Service-Connectors/fe7834cfc5234aab55bb08289aedee850eebe82a/Atlassian/Atlassian%20JIRA%20Cloud%20REST%20API%20v3.json) |
| confluence | `36132acfce799795758e2e8459a84fa42fb1d6d8fd4f0bde191fed9146185bff` | 493127 | [source](https://raw.githubusercontent.com/InformaticaCloudApplicationIntegration/Service-Connectors/fe7834cfc5234aab55bb08289aedee850eebe82a/Atlassian/Atlassian%20Confluence%20Cloud%20REST%20API%20v1.json) |
| salesforce_orders | `3c25ef935045c74c8b2a32e12ba27abbb93ef9ac8be13b12ba8eaed2eb1c2547` | 202473 | [source](https://raw.githubusercontent.com/SalesforceCommerceCloud/commerce-sdk/05ffab5636f9e0dae34bb689ece3b5e5736fd1ed/apis/shopper-orders-oas-1.20.1/shopper-orders-oas-v1-public.yaml) |
| salesforce_customers | `36f9af232d2f008999cab3ae587f071f4bfdba64cfae96f897cfd91f03bf74d1` | 284815 | [source](https://raw.githubusercontent.com/SalesforceCommerceCloud/commerce-sdk/05ffab5636f9e0dae34bb689ece3b5e5736fd1ed/apis/shopper-customers-oas-1.9.0/shopper-customers-oas-v1-public.yaml) |
| stripe | `f0e0fc8fffbffda45bf5f3df59846443c1d47a3cfcbfae232eedf4743124ebee` | 8028700 | [source](https://raw.githubusercontent.com/stripe/openapi/ab25fedb464c6b8866a81dd4217c7305d07790a8/openapi/spec3.json) |
| plaid | `141de8aaaad29c9b81c4d9d3b681711562fb729fe6c45208aaba65fe94852846` | 3163817 | [source](https://raw.githubusercontent.com/plaid/plaid-openapi/457d08b92a569289195312aec8daa712d3324cab/2020-09-14.yml) |
| adyen | `fd59f89f18d134f901d6d42b7aabad1c8afd4e2eb733823ba50944c034f1095a` | 935759 | [source](https://raw.githubusercontent.com/Adyen/adyen-openapi/c4e0d44cf6c0f3dcdff65be8e250fdbfa9da1076/json/CheckoutService-v71.json) |
| docusign | `77f1998c313d69701eca52cb80e860c2a4b7e97bdceea11fd0427f9405f06c2e` | 4846375 | [source](https://raw.githubusercontent.com/docusign/OpenAPI-Specifications/858a3ae59b0edbc8beea4fa3a6d7fe803833dd68/esignature.rest.swagger-v2.1.json) |
| okta | `78e8dfd0c67b6f651b216bc5cf9522ca2127a6c84d623871b61815a42fef8c15` | 3469033 | [source](https://raw.githubusercontent.com/okta/okta-management-openapi-spec/74fcd17fad54332caee96ebbb11fd7f203b03e4f/dist/current/management-minimal.yaml) |
| shopware | `be653e0c3d5ee616d51974434bdbd3392d4a40c275e589bf2cbf74dc0cd795b9` | 4254864 | [source](https://raw.githubusercontent.com/shopware/admin-api-reference/da5e2cabd6be0cd06ace06fc88dc8aedebb62f56/adminapi.json) |
| bigcommerce | `65433a2b6246bfa0bc431bec00faa5782708f8390963bbf5c9f47aeadb6d1a7a` | 211484 | [source](https://raw.githubusercontent.com/bigcommerce/api-specs/dcf48407308710b882374ffafbeefdb0b3598abe/reference/orders.v2.oas2.yml) |
| xero | `0458b4ef9ed72d53fdab89a6c31422b155516115cfa8146ac451f51d778f4582` | 933096 | [source](https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/448060d7829cae23166a2e443be48c2f2422280f/xero_accounting.yaml) |
| box | `0f8794edec1caf44761777f791b36388ec997f4220233a1a0166712e0d3b0a06` | 1780704 | [source](https://raw.githubusercontent.com/box/box-openapi/933ec4c5d9f4dbdaaa823efa3a083cf177aecbde/openapi.json) |
| hubspot | `dcc02ed2d358e462d7be06cf68636ddfa90cbb9822f175197e20740c5f5b1158` | 77526 | [source](https://raw.githubusercontent.com/HubSpot/HubSpot-public-api-spec-collection/2dec5364fd6765bcfa9cf62ea4d06e22aa789d59/PublicApiSpecs/CRM/Deals/Rollouts/424/v3/deals.json) |
| samsara | `26655bccb648fc764c78ec5b7a55d860fab18dbf6f56ac356ab9fb4e3ef43473` | 1415660 | [source](https://raw.githubusercontent.com/samsarahq/api-docs/263d92d9209b174c3d7409db31b45470dbda002a/swagger.json) |
| workday_common | `2372e6c2622918edeaafa2c7f7579ac514f8b370a572172acccf2dd757d3c1b2` | 171236 | [source](https://raw.githubusercontent.com/rapid7/r7-surcom-connectors/cc84ab48722310b3e3182f35ae6c4937597547a3/connectors/rapid7/workday/refdocs/supervisory_organization_swagger.json) |
| workday | — | — | [source](https://community.workday.com/sites/default/files/file-hosting/restapi/index.html) |
| oracle_hcm | — | — | [source](https://docs.oracle.com/en/cloud/saas/human-resources/) |
| oracle_ebs | — | — | [source](https://docs.oracle.com/cd/E26401_01/index.htm) |
| netsuite_rest | — | — | [source](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/) |
| moodle | — | — | [source](https://moodledev.io/docs/5.0/apis/subsystems/external) |
| dynamics365 | — | — | [source](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/web-api-service-documents) |
| business_central | — | — | [source](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/) |
| salesforce_crm | — | — | [source](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest.htm) |
| servicenow | — | — | [source](https://www.servicenow.com/docs/r/api-reference/rest-api-reference.html) |
| teamcenter | — | — | [source](https://plm.sw.siemens.com/en-US/teamcenter/solutions/plm-cloud-saas/) |
| windchill | — | — | [source](https://support.ptc.com/help/windchill_rest_services/r2.7/en/) |
| infor | — | — | [source](https://docs.infor.com/) |
| coupa | — | — | [source](https://compass.coupa.com/en-us/products/product-documentation/integration-technical-documentation/the-coupa-core-api) |

## Findings

### Google Workspace — Admin Directory

discovery_endpoint_collision

- **source-coverage:** 125/128 operations; missing: admin.customers.chrome.printers.delete, admin.customers.chrome.printers.get, admin.customers.chrome.printers.patch; extra: none

### Google Maps — Places

discovery_endpoint_collision

- **source-coverage:** 4/5 operations; missing: places.places.photos.getMedia; extra: none

### Microsoft Graph — teams

duplicate_agent_input_name


### Atlassian Jira Cloud v3 — historical export

query_language_passthrough


### Atlassian Confluence Cloud v1 — historical export

query_language_passthrough


### DocuSign eSignature

duplicate_agent_input_name


### Okta Management

query_language_passthrough


### Xero Accounting

query_language_passthrough


### Workday HCM

Export the selected Staffing/Person/Absence REST service OpenAPI from Workday REST API Explorer. Include its service version and tenant extensions.


### Oracle Fusion HCM

Download the release-specific HCM Swagger from the REST API guide, or export tenant /hcmRestApi/resources/<version>/describe with the OpenAPI media type when supported. The public release and tenant flexfields are different scopes.


### Oracle E-Business Suite

Export the deployed Integrated SOA Gateway REST service. EBS commonly describes REST using WADL, which Anvil does not accept. Supply an actual OpenAPI or reviewed Postman export; a WADL is an adapter gap, not a passing REST conversion.


### Oracle NetSuite — REST records

Export /services/rest/record/v1/metadata-catalog for the selected record types with application/swagger+json. The account's enabled features and custom records affect this contract. The existing SOAP backtest does not cover REST.


### Moodle Workplace / LMS

Export the site's enabled external functions and installed-plugin contracts as reviewed OpenAPI. Moodle core REST is a function-dispatch endpoint, not a vendor-wide OpenAPI. A generic /webservice/rest/server.php skeleton does not establish function coverage.


### Microsoft Dynamics 365 / Dataverse

Export the tenant Web API /api/data/v9.2/$metadata, including custom tables. OData reference services are not Dynamics coverage.


### Microsoft Dynamics 365 Business Central

Export /api/v2.0/$metadata for the selected environment and any extension APIs.


### Salesforce CRM — sObjects and custom objects

Export the reviewed org-specific REST contract or Postman collection, including /sobjects describes. Commerce Cloud contracts do not validate Sales/Service Cloud custom objects.


### ServiceNow — ITSM / industry workflows

Export OpenAPI from REST API Explorer for the instance, plugins and tables under test. Include table-specific fields and query constraints.


### Siemens Teamcenter X

Obtain the licensed deployment's REST API specification from its administrator. Capture version, modules and configuration.


### PTC Windchill REST Services

Export the selected WRS domain's OData $metadata, such as Product Management. Include custom domains separately.


### Infor CloudSuite / ION API

Export authorized API-suite Swagger from the tenant's ION API gateway. Record CloudSuite edition, suite and version.


### Coupa Procurement

Obtain a reviewed contract for the selected Core API resources and tenant custom fields.
