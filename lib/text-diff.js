export function diffLines(beforeText, afterText) {
  const before = String(beforeText ?? "").replace(/\r\n?/g, "\n").split("\n");
  const after = String(afterText ?? "").replace(/\r\n?/g, "\n").split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = before[left] === after[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const result = [];
  let left = 0;
  let right = 0;
  let beforeLine = 1;
  let afterLine = 1;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      result.push({ type: "equal", text: before[left], beforeLine, afterLine });
      left += 1;
      right += 1;
      beforeLine += 1;
      afterLine += 1;
    } else if (right < after.length && (left === before.length || lengths[left][right + 1] >= lengths[left + 1][right])) {
      result.push({ type: "add", text: after[right], beforeLine: null, afterLine });
      right += 1;
      afterLine += 1;
    } else {
      result.push({ type: "remove", text: before[left], beforeLine, afterLine: null });
      left += 1;
      beforeLine += 1;
    }
  }
  return result;
}
