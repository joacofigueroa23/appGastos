// Credenciales de prueba para servidores de test levantados con NODE_ENV=production (nunca valores reales).
export const TEST_AUTH_ENV={APP_AUTH_USER:'test-user',APP_AUTH_PASSWORD:'test-password'};
export const TEST_AUTH_HEADER='Basic '+Buffer.from(TEST_AUTH_ENV.APP_AUTH_USER+':'+TEST_AUTH_ENV.APP_AUTH_PASSWORD).toString('base64');
export const apiFetch=(url:string,init:RequestInit={})=>fetch(url,{...init,headers:{...(init.headers as Record<string,string>),Authorization:TEST_AUTH_HEADER}});
