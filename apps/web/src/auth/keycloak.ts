import Keycloak from 'keycloak-js';

const keycloakUrl = import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080';
const realm = import.meta.env.VITE_KEYCLOAK_REALM || 'smartprocure';
const clientId = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'smartprocure-web';

export const keycloak = new Keycloak({
  url: keycloakUrl,
  realm: realm,
  clientId: clientId,
});
