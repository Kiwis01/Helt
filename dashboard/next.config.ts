import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `@loop/shared` se publica como TypeScript crudo (main: ./index.ts) y vive
  // fuera de dashboard/. Sin transpilePackages, webpack lo trata como JS ya
  // compilado de node_modules y el build falla en el primer `import type`.
  transpilePackages: ['@loop/shared'],

  // No hay ESLint instalado en el workspace y el script `lint` es opcional.
  // Sin esto, `next build` puede intentar resolver una config que no existe.
  eslint: { ignoreDuringBuilds: true },

  // Los errores de tipos SÍ tienen que romper el build: es la única red de
  // seguridad contra un cambio de contrato en shared/ que nadie avisó.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
