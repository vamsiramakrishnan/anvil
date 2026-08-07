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

  it("discovers explicit Jakarta EJB source annotations without compiling or loading code", () => {
    const result = collectJavaEeLegacy(
      {
        "src/main/java/com/acme/RefundRemote.java": `package com.acme;
          import jakarta.ejb.Remote;
          @Remote public interface RefundRemote { void refund(String id); }`,
        "src/main/java/com/acme/RefundBean.java": `package com.acme;
          import jakarta.ejb.Stateless;
          @Stateless(name = "Refunds", mappedName = "ejb/refunds")
          public final class RefundBean implements RefundRemote { }`,
        "src/main/java/com/acme/RefundCommands.java": `package com.acme;
          @jakarta.ejb.MessageDriven(
            name = "RefundCommands",
            messageListenerInterface = jakarta.jms.MessageListener.class,
            activationConfig = {
              @jakarta.ejb.ActivationConfigProperty(
                propertyName = "destinationLookup",
                propertyValue = "jms/refundCommands"),
              @jakarta.ejb.ActivationConfigProperty(
                propertyName = "destinationType",
                propertyValue = "jakarta.jms.Queue")
            })
          public class RefundCommands implements jakarta.jms.MessageListener { }`,
      },
      { application: "refunds", platform: "weblogic" },
    );

    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "weblogic",
          component: expect.objectContaining({
            kind: "session_bean",
            name: "Refunds",
            className: "com.acme.RefundBean",
            interfaces: expect.objectContaining({ remote: ["com.acme.RefundRemote"] }),
          }),
          binding: expect.objectContaining({ physicalName: "ejb/refunds" }),
        }),
        expect.objectContaining({
          component: expect.objectContaining({
            kind: "message_driven_bean",
            name: "RefundCommands",
          }),
          binding: expect.objectContaining({
            physicalName: "jms/refundCommands",
            destinationType: "jakarta.jms.Queue",
          }),
          attributes: expect.objectContaining({ messagingType: "jakarta.jms.MessageListener" }),
        }),
      ]),
    );
    expect(result.evidence.filter((item) => item.role === "source_annotation")).toHaveLength(3);
    expect(result.observations.every((item) => item.evidence[0]?.pointer.includes("@line:"))).toBe(
      true,
    );
  });

  it("does not treat annotation-shaped comments, strings, or text blocks as declarations", () => {
    const result = collectJavaEeLegacy({
      "src/Noise.java": `class Noise {
        // @MessageDriven(name = "Comment") class Comment {}
        String value = "@Stateless class StringBean {}";
        String block = """@Remote interface TextRemote {}""";
      }`,
    });

    expect(result.evidence[0]?.role).toBe("uninterpreted");
    expect(result.observations).toEqual([]);
  });

  it("keeps source-only session beans explicit when a remote interface cannot be proved", () => {
    const result = collectJavaEeLegacy({
      "src/Worker.java": `@javax.ejb.Stateless public class Worker implements Runnable { }`,
    });

    expect(result.observations[0]?.component).toMatchObject({
      kind: "session_bean",
      name: "Worker",
      interfaces: { remote: [], local: [], home: [], localHome: [] },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/source_annotation_incomplete" }),
    );
  });

  it("does not select conflicting or comment-only activation destinations", () => {
    const result = collectJavaEeLegacy({
      "src/Commands.java": `import jakarta.ejb.*;
      @MessageDriven(activationConfig = {
        // @ActivationConfigProperty(propertyName="destinationLookup", propertyValue="jms/comment")
        @ActivationConfigProperty(propertyName="destinationLookup", propertyValue="jms/one"),
        @ActivationConfigProperty(propertyName="destinationLookup", propertyValue="jms/two")
      }) public class Commands { }`,
    });

    expect(result.observations[0]?.binding?.physicalName).toBeUndefined();
    expect(result.observations[0]?.binding?.properties).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("jms/comment");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "java-ee/ambiguous_binding" }),
        expect.objectContaining({ code: "java-ee/unresolved_binding" }),
      ]),
    );
  });

  it("does not confuse same-named application annotations with EJB annotations", () => {
    const result = collectJavaEeLegacy({
      "src/Fake.java": `package application;
        @MessageDriven(name = "NotAnEjb") public class Fake { }`,
    });

    expect(result.evidence[0]?.role).toBe("source_annotation");
    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/no_discoverable_declaration" }),
    );
  });

  it("records classfiles by digest with a precise non-execution diagnostic", () => {
    const result = collectJavaEeLegacy({ "classes/com/acme/Worker.class": "CAFEBABE" });

    expect(result.observations).toEqual([]);
    expect(result.evidence[0]?.role).toBe("class_metadata");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/classfile_metadata_unavailable" }),
    );
  });

  it("emits an actionable diagnostic for every recognized descriptor with zero facts", () => {
    const result = collectJavaEeLegacy({
      "empty/WEB-INF/web.xml": "<web-app/>",
      "empty/META-INF/ejb-jar.xml": "<ejb-jar/>",
    });

    expect(result.observations).toEqual([]);
    expect(
      result.diagnostics.filter((item) => item.code === "java-ee/no_discoverable_declaration"),
    ).toHaveLength(2);
  });

  it("extracts WebLogic JMS modules and deployment-plan module evidence", () => {
    const result = collectJavaEeLegacy(
      {
        "config/payments-jms.xml": `<weblogic-jms xmlns="http://xmlns.oracle.com/weblogic/weblogic-jms">
          <queue name="PaymentCommands"><jndi-name>jms/paymentCommands</jndi-name><sub-deployment-name>JMSServer</sub-deployment-name></queue>
          <uniform-distributed-topic name="PaymentEvents"><jndi-name>jms/paymentEvents</jndi-name></uniform-distributed-topic>
          <connection-factory name="PaymentsFactory"><jndi-name>jms/paymentsFactory</jndi-name></connection-factory>
        </weblogic-jms>`,
        "config/deployment-plan.xml": `<deployment-plan xmlns="http://xmlns.oracle.com/weblogic/deployment-plan">
          <module-override><module-name>payments-jms.xml</module-name><module-type>JMS</module-type>
            <module-descriptor><root-element>weblogic-jms</root-element></module-descriptor>
          </module-override>
        </deployment-plan>`,
      },
      { application: "payments" },
    );

    expect(result.observations.map((item) => [item.component.kind, item.component.name])).toEqual(
      expect.arrayContaining([
        ["messaging_destination", "PaymentCommands"],
        ["messaging_destination", "PaymentEvents"],
        ["connection_factory", "PaymentsFactory"],
        ["module", "payments-jms.xml"],
      ]),
    );
  });

  it("extracts WebSphere Liberty resources and activation specifications", () => {
    const result = collectJavaEeLegacy(
      {
        "liberty/server.xml": `<server xmlns="http://www.ibm.com/xmlns/prod/websphere/liberty">
          <jmsQueue id="OrderQueue" jndiName="jms/orders"/>
          <jmsConnectionFactory id="OrderFactory" jndiName="jms/ordersFactory"/>
          <jmsActivationSpec id="OrderActivation" jndiName="eis/orderActivation"/>
        </server>`,
      },
      { application: "orders", platform: "websphere" },
    );

    expect(
      result.observations.map((item) => [item.component.kind, item.binding?.physicalName]),
    ).toEqual(
      expect.arrayContaining([
        ["messaging_destination", "jms/orders"],
        ["connection_factory", "jms/ordersFactory"],
        ["resource_environment_reference", "eis/orderActivation"],
      ]),
    );
  });

  it("preserves multiple WildFly JNDI aliases without choosing one", () => {
    const result = collectJavaEeLegacy(
      {
        "wildfly/standalone.xml": `<server xmlns="urn:jboss:domain:messaging-activemq:13.0">
          <jms-queue name="Orders"><entry name="java:/jms/queue/Orders"/><entry name="java:jboss/exported/jms/Orders"/></jms-queue>
        </server>`,
      },
      { platform: "jboss" },
    );

    expect(result.observations[0]?.binding).toMatchObject({
      resolution: "opaque",
      properties: {
        jndiEntries: '["java:/jms/queue/Orders","java:jboss/exported/jms/Orders"]',
      },
    });
    expect(result.observations[0]?.binding?.physicalName).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "java-ee/ambiguous_binding" }),
    );
  });
});
