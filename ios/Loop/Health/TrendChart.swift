import Charts
import SwiftUI

/// The weekly trend with the medication timeline drawn over it. The overlay is
/// the point of the chart: it is what lets someone see whether a change in
/// treatment lines up with a change in their numbers.
///
/// A headline number sits above it, because a line alone never answers "what
/// was my reading?" — and after the reading is over, that number is exactly
/// what the person is owed.
struct WeeklyTrendChart: View {
    let points: [WeeklyPoint]
    let events: [MedicationEvent]
    let unit: String
    /// Medication marks are the only place colour carries meaning.
    var showsEvents = true

    @State private var selectedDate: Date?

    /// Whatever the person tapped, else the most recent week.
    private var displayed: WeeklyPoint? {
        guard let selectedDate else { return points.last }
        return points.min {
            abs($0.weekStart.timeIntervalSince(selectedDate))
                < abs($1.weekStart.timeIntervalSince(selectedDate))
        }
    }

    private var domain: ClosedRange<Double> {
        let values = points.map(\.value)
        guard let low = values.min(), let high = values.max() else { return 0...100 }
        let pad = max(4, (high - low) * 0.25)
        return (low - pad)...(high + pad)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            headline
            // Room for the medication annotations, which float above the plot.
            chart.padding(.top, showsEvents && !events.isEmpty ? 16 : 0)
        }
    }

    // MARK: - Headline

    @ViewBuilder
    private var headline: some View {
        if let displayed {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(displayed.value, format: .number.precision(.fractionLength(0)))
                        .font(.system(size: 42, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    Text(unit)
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                Text(caption(for: displayed))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .animation(.smooth(duration: 0.2), value: displayed.weekStart)
        }
    }

    private func caption(for point: WeeklyPoint) -> String {
        let calendar = Calendar.current
        if calendar.isDate(point.weekStart, equalTo: .now, toGranularity: .weekOfYear) {
            return selectedDate == nil ? "Your reading this week" : "This week"
        }
        return "Week of \(point.weekStart.formatted(.dateTime.month(.abbreviated).day()))"
    }

    // MARK: - Chart

    private var chart: some View {
        Chart {
            ForEach(points) { point in
                LineMark(
                    x: .value("Week", point.weekStart, unit: .weekOfYear),
                    y: .value(unit, point.value)
                )
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .foregroundStyle(Color.primary)

                PointMark(
                    x: .value("Week", point.weekStart, unit: .weekOfYear),
                    y: .value(unit, point.value)
                )
                .symbolSize(point.weekStart == displayed?.weekStart ? 130 : 28)
                .foregroundStyle(Color.primary)
            }

            if showsEvents {
                ForEach(events) { event in
                    RuleMark(x: .value("Week", event.date, unit: .weekOfYear))
                        .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        .foregroundStyle(.blue)
                        .annotation(position: .top, alignment: .center, spacing: 4) {
                            Text(event.kind.label.lowercased())
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.blue)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.blue.opacity(0.12), in: .capsule)
                        }
                }
            }
        }
        .chartXSelection(value: $selectedDate)
        .chartYScale(domain: domain)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel()
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .month)) {
                AxisValueLabel(format: .dateTime.month(.abbreviated))
            }
        }
        .chartLegend(.hidden)
    }
}

/// Reads the marks out loud so the chart isn't the only way to get the point.
struct MedicationLegend: View {
    let events: [MedicationEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(events) { event in
                HStack(spacing: 10) {
                    Rectangle()
                        .fill(.blue)
                        .frame(width: 2, height: 14)
                    Text(event.summary)
                        .font(.subheadline)
                    Spacer()
                    Text(event.date, format: .dateTime.month(.abbreviated).day())
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Trend") {
    WeeklyTrendChart(points: MockData.readingAverages, events: MockData.events, unit: "bpm")
        .frame(height: 300)
        .padding()
}

#Preview("Single reading") {
    WeeklyTrendChart(
        points: [WeeklyPoint(weekStart: MockData.weekStart(0), value: 64)],
        events: [],
        unit: "bpm"
    )
    .frame(height: 300)
    .padding()
}
