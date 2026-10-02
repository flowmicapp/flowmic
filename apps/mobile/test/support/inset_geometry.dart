import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class InsetCase {
  const InsetCase(
    this.name, {
    this.size = const Size(390, 844),
    this.bottom = 48,
    this.ime = 0,
    this.scale = 1,
    this.top = 44,
    this.left = 18,
    this.right = 12,
  });
  final String name;
  final Size size;
  final double bottom, ime, scale, top, left, right;
  Rect get safe => Rect.fromLTRB(
    left,
    top,
    size.width - right,
    size.height - (ime > bottom ? ime : bottom),
  );

  void apply(WidgetTester tester) {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    tester.view.viewPadding = FakeViewPadding(
      top: top,
      left: left,
      right: right,
      bottom: bottom,
    );
    tester.view.padding = FakeViewPadding(
      top: top,
      left: left,
      right: right,
      bottom: ime == 0 ? bottom : 0,
    );
    tester.view.viewInsets = FakeViewPadding(bottom: ime);
    addTearDown(tester.view.reset);
  }

  Widget app(Widget home) => MaterialApp(
    builder: (BuildContext context, Widget? child) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: TextScaler.linear(scale)),
      child: child!,
    ),
    home: home,
  );
}

const insetCases = <InsetCase>[
  InsetCase('nav48'),
  InsetCase('nav80', bottom: 80),
  InsetCase('ime300-nav48', ime: 300),
  InsetCase('ime300-nav80', bottom: 80, ime: 300),
  InsetCase('large-text', bottom: 80, scale: 1.8),
  InsetCase(
    'landscape',
    size: Size(640, 390),
    bottom: 80,
    left: 44,
    right: 24,
    top: 24,
  ),
];

void expectInside(
  WidgetTester tester,
  Finder target,
  InsetCase c, {
  bool hit = true,
}) {
  expect(target, findsOneWidget);
  final Rect rect = tester.getRect(target);
  expect(rect.width, greaterThan(0));
  expect(rect.height, greaterThan(0));
  expect(
    rect.bottom,
    lessThanOrEqualTo(c.safe.bottom + 0.01),
    reason: '${c.name}: bottom $rect',
  );
  expect(
    rect.left,
    greaterThanOrEqualTo(c.safe.left - 0.01),
    reason: '${c.name}: left $rect',
  );
  expect(
    rect.right,
    lessThanOrEqualTo(c.safe.right + 0.01),
    reason: '${c.name}: right $rect',
  );
  expect(
    rect.top,
    greaterThanOrEqualTo(c.safe.top - 0.01),
    reason: '${c.name}: top $rect',
  );
  if (hit) {
    expect(
      target.hitTestable(),
      findsOneWidget,
      reason: '${c.name}: hit target',
    );
  }
}

Future<void> openSheet(
  WidgetTester tester,
  InsetCase c,
  void Function(BuildContext) open,
) async {
  c.apply(tester);
  await tester.pumpWidget(
    c.app(
      Scaffold(
        body: Builder(
          builder: (BuildContext context) => Center(
            child: TextButton(
              onPressed: () => open(context),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Future<void> reveal(WidgetTester tester, Finder target) async {
  if (target.evaluate().isEmpty) {
    final Finder vertical = find
        .byWidgetPredicate(
          (Widget w) =>
              w is Scrollable &&
              (w.axisDirection == AxisDirection.down ||
                  w.axisDirection == AxisDirection.up),
        )
        .last;
    await tester.scrollUntilVisible(
      target,
      180,
      scrollable: vertical,
      maxScrolls: 60,
    );
  }
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
}
