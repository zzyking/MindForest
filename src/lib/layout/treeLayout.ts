export interface OrbitLayoutOptions {
  radius: number;
  offset?: number;
}

export function computeOrbitPositions(count: number, radius: number, offset = -Math.PI / 2) {
  return Array.from({ length: count }, (_, i) => {
    const angle = count === 1 ? Math.PI / 2 : (i / count) * 2 * Math.PI + offset;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    };
  });
}
