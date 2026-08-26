import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/ports/__tests__/setup-env.ts'],

    // 20 s en vez de los 5 s de default (👤 2026-08-26, al cablear la suite al CI).
    //
    // POR QUÉ. Los tests más lentos de este repo son los que **levantan un
    // Fastify de verdad** para probar auth de ruta (`/send`, `/mark-read`,
    // `/management`, `/mcp`): 200-500 ms en una máquina ociosa. Ninguno mide
    // latencia — todos afirman un status code —, así que el timeout no es parte
    // de lo que prueban: es sólo el techo antes de que vitest los mate.
    //
    // Con la máquina cargada esa familia se pasó de los 5 s y tiró 3 fallos que
    // NO se reprodujeron en 5 corridas limpias posteriores (la corrida mala tuvo
    // 81 s de import contra 11 s de las buenas: event loop hambreado, no un bug).
    // Un runner de CI arranca en frío y es más lento que esta máquina, así que
    // el mismo fallo llegaría allá — y como `build-image.yml` ahora declara
    // `needs: test`, un timeout espurio no rompe un test: **frena el deploy**.
    //
    // Identificados bajando el timeout a propósito (`--testTimeout=60`), que es
    // determinista y no depende de reproducir la carga.
    //
    // ⚠ Esto da AIRE, no esconde: un test incorrecto sigue fallando igual, y a
    // propósito NO se agregan reintentos (`retry`), que es lo que sí taparía un
    // flake real. Si un test tarda 20 s, eso es un bug y tiene que doler.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
