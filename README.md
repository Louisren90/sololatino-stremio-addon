# SoloLatino → Stremio Addon

Addon para Stremio que expone el catálogo y metadatos públicos de SoloLatino y proporciona un enlace externo hacia la página de cada título.

## Qué incluye

- Catálogo de películas.
- Catálogo de series.
- Búsqueda desde Stremio.
- Metadatos básicos: título, año, descripción, géneros y poster cuando están disponibles.
- Enlace externo "Abrir en SoloLatino".
- Servidor Node.js + Express.
- CORS habilitado para Stremio.
- Caché temporal para reducir solicitudes.

## Importante

Este proyecto **no extrae, descarga, retransmite ni convierte URLs de servidores de vídeo en streams de Stremio**. El recurso `stream` usa `externalUrl` para abrir la página de origen.

Asegúrate de tener derecho o permiso para integrar y mostrar el contenido que utilices.

## Requisitos

- Node.js 18 o superior.
- npm.

## Instalación local

```bash
npm install
npm start
```

Por defecto quedará en:

```text
http://localhost:7000/manifest.json
```

En Stremio:

1. Abre la sección de addons.
2. Usa la instalación desde URL.
3. Introduce la URL de `manifest.json`.
4. Instala el addon.

Para Stremio en otro dispositivo, `localhost` no funcionará: debes desplegar el servidor en un equipo accesible desde ese dispositivo.

## Despliegue

Puedes desplegar esta carpeta en cualquier servicio que ejecute Node.js.

Variables opcionales:

- `PORT`: puerto HTTP.
- `CACHE_TTL_MS`: duración de la caché en milisegundos.
- `USER_AGENT`: User-Agent para las solicitudes.

Ejemplo:

```bash
npm install
npm start
```

Después utiliza:

```text
https://TU-DOMINIO/manifest.json
```

como URL de instalación en Stremio.

## Estructura

```text
sololatino-stremio-addon/
├── manifest.json
├── package.json
├── server.js
├── README.md
└── .gitignore
```
