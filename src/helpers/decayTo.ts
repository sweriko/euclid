// Exponential decay interpolation
// rate usually between 1 and 25
export default function decayTo(current: number, target: number, deltaS: number, rate: number = 16): number {
  return target + (current - target) * Math.exp(-rate * deltaS);
}















