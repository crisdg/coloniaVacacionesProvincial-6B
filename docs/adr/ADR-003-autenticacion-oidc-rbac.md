# ADR-003: Autenticación delegada OIDC y autorización RBAC

- **Estado:** Aceptado.
- **Fuente:** Documento del escenario 6B, ADR-003.

## Contexto

El sistema distingue dos roles: tutor o familia, que solicita inscripciones y consulta las propias, y administrador, que gestiona turnos, cupos e inscripciones. Implementar credenciales, almacenamiento de contraseñas y emisión de tokens dentro del negocio agregaría responsabilidades de seguridad que no son el propósito del sistema.

## Decisión

Delegar la autenticación en un proveedor de identidad que implemente OpenID Connect (OIDC), utilizando Keycloak en el proyecto. OIDC aporta la identidad del usuario sobre OAuth 2.0; OAuth 2.0 por sí solo no define un protocolo de autenticación.

Aplicar autorización basada en roles (RBAC): los permisos se asignan a `tutor` y `administrador`, y los usuarios reciben esos roles. El frontend y Swagger son clientes públicos y utilizan Authorization Code con PKCE, sin un secreto que deban guardar en el navegador.

La validación del token y los permisos por operación se centralizan en el gateway, según el [ADR-007](ADR-007-validacion-del-token.md). La API comprueba la titularidad de los recursos: tener rol tutor no autoriza a leer inscripciones de otros tutores.

## Alternativas evaluadas

- **Autenticación propia:** descartada porque no aporta diferenciación al dominio e incrementa el riesgo y el mantenimiento de seguridad.
- **Autorización basada en atributos (ABAC):** descartada por el momento a favor de la simplicidad de los dos roles definidos. Se mantienen los controles de titularidad que necesita el dominio.

## Consecuencias

- Estandariza el inicio de sesión y concentra la gestión de identidad en Keycloak.
- Permite incorporar usuarios asignándoles roles, sin definir permisos individuales para cada persona.
- Introduce dependencia del proveedor para iniciar sesión y emitir o renovar tokens.
- Exige mantener consistentes roles, clientes, audiencia y redirecciones entre el proveedor y los consumidores.
- La configuración local de Keycloak en modo desarrollo no constituye una configuración de producción.

## Atributos de calidad

Favorece la seguridad y la mantenibilidad. Introduce una dependencia de disponibilidad en el proveedor de identidad y trabajo de configuración de la integración.

## Implementación y referencias

- [Realm de Keycloak](../../auth/keycloak/realm-colonia.json): clientes, roles y usuarios de prueba.
- [Login del frontend](../../frontend/auth.js): flujo OIDC con PKCE.
- [Gateway](../../auth/gateway/src/index.js): reglas por rol y verificación del token.
- [Identidad en la API](../../api/src/shared/identidad.js) y [rutas de inscripciones](../../api/src/modules/inscripciones/routes.js): identidad recibida y control de titularidad.
- [ADR-007](ADR-007-validacion-del-token.md): complemento de esta decisión, denominado ADR-006 en el documento fuente.
