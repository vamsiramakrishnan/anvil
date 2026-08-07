import { describe, expect, it } from "vitest";
import { collectJavaEeLegacy } from "./collector.js";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

describe("offline Java EE legacy collector", () => {
  it("refuses DTD/entity declarations without resolving or expanding them", () => {
    const source = `${XML_HEADER}
<!DOCTYPE ejb-jar [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<ejb-jar><enterprise-beans><session><ejb-name>&secret;</ejb-name></session></enterprise-beans></ejb-jar>`;

    const result = collectJavaEeLegacy([{ path: "orders/META-INF/ejb-jar.xml", content: source }]);

    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/unsafe_xml_construct", level: "error" }),
    );
    expect(result.evidence).toHaveLength(1);
  });

  it("rejects traversal, absolute, backslash, and duplicate member paths", () => {
    const descriptor = "<ejb-jar/>";
    const result = collectJavaEeLegacy([
      { path: "../META-INF/ejb-jar.xml", content: descriptor },
      { path: "/META-INF/ejb-jar.xml", content: descriptor },
      { path: "app\\META-INF\\ejb-jar.xml", content: descriptor },
      { path: "app/META-INF/ejb-jar.xml", content: descriptor },
      { path: "app/META-INF/ejb-jar.xml", content: "<different/>" },
    ]);

    expect(result.evidence).toEqual([]);
    expect(
      result.diagnostics.filter((item) => item.code === "java-ee/unsafe_member_path"),
    ).toHaveLength(3);
    expect(
      result.diagnostics.filter((item) => item.code === "java-ee/duplicate_member_path"),
    ).toHaveLength(1);
  });

  it("reports malformed descriptor XML as a diagnostic instead of throwing", () => {
    const result = collectJavaEeLegacy({
      "billing/WEB-INF/web.xml": "<web-app><resource-ref></web-app>",
    });

    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/malformed_xml", level: "error" }),
    );
  });

  it("preserves duplicate component declarations as competing observations", () => {
    const result = collectJavaEeLegacy(
      {
        "billing/META-INF/ejb-jar.xml": `<ejb-jar><enterprise-beans>
          <session><ejb-name>LedgerBean</ejb-name><remote>com.acme.Ledger</remote></session>
          <session><ejb-name>LedgerBean</ejb-name><remote>com.acme.LedgerV2</remote></session>
        </enterprise-beans></ejb-jar>`,
      },
      { application: "billing" },
    );

    const beans = result.observations.filter((item) => item.component.kind === "session_bean");
    expect(beans).toHaveLength(2);
    expect(new Set(beans.map((item) => item.id)).size).toBe(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/duplicate_identity", level: "error" }),
    );
  });

  it("marks explicitly local-only session beans without inventing a remote surface", () => {
    const result = collectJavaEeLegacy({
      "pricing/META-INF/ejb-jar.xml": `<ejb-jar><enterprise-beans><session>
        <ejb-name>PriceRules</ejb-name>
        <local>com.acme.PriceRulesLocal</local>
        <business-local>com.acme.PriceRulesBusinessLocal</business-local>
        <ejb-class>com.acme.PriceRulesBean</ejb-class>
      </session></enterprise-beans></ejb-jar>`,
    });

    const bean = result.observations.find((item) => item.component.name === "PriceRules");
    expect(bean?.component.localOnly).toBe(true);
    expect(bean?.component.interfaces?.remote).toEqual([]);
    expect(bean?.component.interfaces?.local).toEqual([
      "com.acme.PriceRulesBusinessLocal",
      "com.acme.PriceRulesLocal",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/local_only_ejb", level: "info" }),
    );
  });

  it("preserves MDB destination, destination type, and activation properties", () => {
    const result = collectJavaEeLegacy({
      "refunds/META-INF/ejb-jar.xml": `<ejb-jar><enterprise-beans><message-driven>
        <ejb-name>RefundCommands</ejb-name>
        <ejb-class>com.acme.RefundCommands</ejb-class>
        <activation-config>
          <activation-config-property>
            <activation-config-property-name>destinationLookup</activation-config-property-name>
            <activation-config-property-value>jms/refundRequests</activation-config-property-value>
          </activation-config-property>
          <activation-config-property>
            <activation-config-property-name>destinationType</activation-config-property-name>
            <activation-config-property-value>jakarta.jms.Queue</activation-config-property-value>
          </activation-config-property>
          <activation-config-property>
            <activation-config-property-name>messageSelector</activation-config-property-name>
            <activation-config-property-value>type = 'REFUND'</activation-config-property-value>
          </activation-config-property>
        </activation-config>
      </message-driven></enterprise-beans></ejb-jar>`,
    });

    const mdb = result.observations.find((item) => item.component.kind === "message_driven_bean");
    expect(mdb?.binding).toMatchObject({
      kind: "jms_destination",
      physicalName: "jms/refundRequests",
      destinationType: "jakarta.jms.Queue",
      resolution: "declared",
      properties: {
        destinationLookup: "jms/refundRequests",
        destinationType: "jakarta.jms.Queue",
        messageSelector: "type = 'REFUND'",
      },
    });
    expect(result.diagnostics.some((item) => item.code === "java-ee/unresolved_binding")).toBe(
      false,
    );
  });

  it("extracts application modules, web references, and resource-adapter definitions", () => {
    const result = collectJavaEeLegacy({
      "META-INF/application.xml": `<application>
        <application-name>commerce</application-name>
        <module><web><web-uri>checkout.war</web-uri><context-root>/checkout</context-root></web></module>
        <module><ejb>orders.jar</ejb></module>
        <module><connector>erp.rar</connector></module>
      </application>`,
      "checkout.war/WEB-INF/web.xml": `<web-app>
        <resource-ref><res-ref-name>jdbc/Orders</res-ref-name><res-type>javax.sql.DataSource</res-type><lookup-name>java:comp/env/jdbc/orders</lookup-name></resource-ref>
        <resource-env-ref><resource-env-ref-name>jms/OrderEvents</resource-env-ref-name><resource-env-ref-type>jakarta.jms.Topic</resource-env-ref-type></resource-env-ref>
      </web-app>`,
      "erp.rar/META-INF/ra.xml": `<connector><resourceadapter>
        <outbound-resourceadapter><connection-definition>
          <managedconnectionfactory-class>com.acme.ErpManagedConnectionFactory</managedconnectionfactory-class>
          <connectionfactory-interface>com.acme.ErpConnectionFactory</connectionfactory-interface>
          <connectionfactory-impl-class>com.acme.ErpConnectionFactoryImpl</connectionfactory-impl-class>
          <connection-interface>com.acme.ErpConnection</connection-interface>
        </connection-definition></outbound-resourceadapter>
        <inbound-resourceadapter><messageadapter><messagelistener>
          <messagelistener-type>com.acme.ErpListener</messagelistener-type>
          <activationspec><activationspec-class>com.acme.ErpActivationSpec</activationspec-class></activationspec>
        </messagelistener></messageadapter></inbound-resourceadapter>
        <adminobject><adminobject-interface>jakarta.jms.Queue</adminobject-interface><adminobject-class>com.acme.QueueAdminObject</adminobject-class></adminobject>
      </resourceadapter></connector>`,
    });

    expect(
      result.observations
        .filter((item) => item.component.kind === "module")
        .map((item) => item.component.name)
        .sort(),
    ).toEqual(["checkout.war", "erp.rar", "orders.jar"]);
    expect(
      result.observations.find((item) => item.component.name === "jdbc/Orders")?.binding,
    ).toMatchObject({ physicalName: "java:comp/env/jdbc/orders", resolution: "mapped" });
    expect(
      result.observations.find((item) => item.component.name === "jms/OrderEvents")?.binding,
    ).toMatchObject({ resolution: "unresolved" });
    expect(
      result.observations.find((item) => item.component.kind === "connection_definition")
        ?.component,
    ).toMatchObject({
      name: "com.acme.ErpConnectionFactory",
      className: "com.acme.ErpManagedConnectionFactory",
    });
    expect(
      result.observations.find((item) => item.component.kind === "message_listener")?.attributes,
    ).toEqual({ activationSpecClass: "com.acme.ErpActivationSpec" });
    expect(
      result.observations.find((item) => item.component.kind === "admin_object")?.component,
    ).toMatchObject({ name: "jakarta.jms.Queue", className: "com.acme.QueueAdminObject" });
  });

  it("extracts WebLogic, WebSphere, and JBoss mappings only as declared bindings", () => {
    const result = collectJavaEeLegacy(
      {
        "refunds/META-INF/weblogic-ejb-jar.xml": `<weblogic-ejb-jar>
          <weblogic-enterprise-bean><ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds</jndi-name></weblogic-enterprise-bean>
          <weblogic-enterprise-bean><ejb-name>RefundCommands</ejb-name><message-driven-descriptor>
            <destination-jndi-name>jms/refundRequests</destination-jndi-name>
            <connection-factory-jndi-name>jms/legacyFactory</connection-factory-jndi-name>
          </message-driven-descriptor></weblogic-enterprise-bean>
        </weblogic-ejb-jar>`,
        "refunds/WEB-INF/weblogic.xml": `<weblogic-web-app><resource-description>
          <res-ref-name>jdbc/Refunds</res-ref-name><jndi-name>jdbc/refundDatasource</jndi-name>
        </resource-description></weblogic-web-app>`,
        "orders/META-INF/ibm-ejb-jar-bnd.xml": `<ejb-jar-bnd xmlns="http://websphere.ibm.com/xml/ns/javaee">
          <session name="OrdersBean"><interface class="com.acme.Orders" binding-name="ejb/orders"/></session>
          <message-driven name="OrderCommands"><jca-adapter activation-spec-binding-name="eis/orderActivation" destination-binding-name="jms/orderCommands"/></message-driven>
        </ejb-jar-bnd>`,
        "stock/META-INF/jboss-ejb3.xml": `<jboss xmlns="urn:jboss:jboss-ejb3:2.0"><enterprise-beans>
          <session><ejb-name>StockBean</ejb-name><jndi-name>java:global/stock/StockBean</jndi-name></session>
        </enterprise-beans></jboss>`,
      },
      { application: "legacy-suite" },
    );

    expect(
      result.observations.map((item) => [
        item.platform,
        item.component.name,
        item.binding?.physicalName,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["weblogic", "RefundBean", "ejb/refunds"],
        ["weblogic", "RefundCommands", "jms/refundRequests"],
        ["weblogic", "jdbc/Refunds", "jdbc/refundDatasource"],
        ["websphere", "OrdersBean", "ejb/orders"],
        ["websphere", "OrderCommands", "jms/orderCommands"],
        ["jboss", "StockBean", "java:global/stock/StockBean"],
      ]),
    );
  });

  it("is deterministic across input map ordering and records uninterpreted members", () => {
    const left = collectJavaEeLegacy({
      "z/readme.txt": "not executable",
      "a/WEB-INF/web.xml": "<web-app/>",
    });
    const right = collectJavaEeLegacy({
      "a/WEB-INF/web.xml": "<web-app/>",
      "z/readme.txt": "not executable",
    });

    expect(left).toEqual(right);
    expect(left.evidence.find((item) => item.path === "z/readme.txt")?.role).toBe("uninterpreted");
    expect(left.collector).toMatchObject({
      mode: "offline_expanded_members",
      deterministic: true,
      archiveAccess: false,
      bytecodeExecution: false,
    });
  });
});
