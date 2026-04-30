/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Silence the noisy framer-motion source-map 404s in dev. We don't ship
  // browser source maps in prod regardless.
  productionBrowserSourceMaps: false,
};

export default nextConfig;
