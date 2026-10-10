import { expect, test } from "bun:test"
import { summarizeFrames } from "./frames"

test("vsync is the tenth-percentile interval, not the median", () => {
  const intervals = [33, 33, 33, 33, 33, 33, 33, 33, 16, 16]
  const result = summarizeFrames(intervals, 0)
  expect(result.vsyncMs).toBe(16)
  expect(result.late).toBe(8)
})

test("the tenth percentile of twenty unsorted intervals is the second smallest", () => {
  const intervals = [29, 10, 22, 11, 28, 12, 27, 13, 26, 14, 25, 15, 24, 16, 23, 17, 21, 18, 20, 19]
  const result = summarizeFrames(intervals, 0)
  expect(result.vsyncMs).toBe(11)
  expect(result.late).toBe(13)
  expect(result.worstMs).toBe(29)
  expect(result.intervals).toEqual(intervals)
})

test("an interval of exactly 1.5 vsync periods is not late", () => {
  const steady = Array.from({ length: 9 }, () => 20)
  expect(summarizeFrames([...steady, 30], 0).late).toBe(0)
})

test("an interval just over 1.5 vsync periods is late", () => {
  const steady = Array.from({ length: 9 }, () => 20)
  expect(summarizeFrames([...steady, 30.5], 0).late).toBe(1)
})

test("the worst interval is the largest wherever it falls in the sequence", () => {
  expect(summarizeFrames([16, 90, 16, 16, 16], 0).worstMs).toBe(90)
})

test("elapsed time is passed through unchanged", () => {
  expect(summarizeFrames([16, 16], 2345.5).elapsedMs).toBe(2345.5)
})

test("no intervals gives zeros", () => {
  expect(summarizeFrames([], 100)).toEqual({
    intervals: [],
    vsyncMs: 0,
    late: 0,
    worstMs: 0,
    elapsedMs: 100,
  })
})

test("a single interval is its own vsync period, worst interval and never late", () => {
  expect(summarizeFrames([16], 40)).toEqual({
    intervals: [16],
    vsyncMs: 16,
    late: 0,
    worstMs: 16,
    elapsedMs: 40,
  })
})
