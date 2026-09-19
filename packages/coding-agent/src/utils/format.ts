export function formatUsd(cost: number, decimals = 2): string {
	return `$${cost.toFixed(decimals)}`;
}
