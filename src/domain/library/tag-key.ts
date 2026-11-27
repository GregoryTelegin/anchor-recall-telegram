/** Case-insensitive tag identity without catalogue or schema dependencies. */
export const tagKey = (value: string): string => value.toLocaleLowerCase();
