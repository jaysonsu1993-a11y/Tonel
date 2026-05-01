// S1RoundedButton.mm — Custom NSButton with drawRect-based background.
// Fixes the wantsLayer=YES + bordered=NO hit-testing bug where mouse clicks
// pass through the button instead of being handled.
#import "S1RoundedButton.h"

@implementation S1RoundedButton

- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        self.bordered = NO;
        self.bezelStyle = NSBezelStyleRegularSquare;
    }
    return self;
}

- (void)drawRect:(NSRect)dirtyRect {
    if (_fillColor) {
        NSBezierPath* path = [NSBezierPath bezierPathWithRoundedRect:self.bounds
                                                             xRadius:8.0
                                                             yRadius:8.0];
        [_fillColor setFill];
        [path fill];
    }
    [super drawRect:dirtyRect];
}

- (BOOL)isOpaque {
    return NO;
}

// Hit testing must return self so clicks are delivered to the button.
// The point passed to hitTest: is already in the receiver's (self's)
// coordinate space — no conversion needed.
-(NSView*)hitTest:(NSPoint)point {
    // point 是在 superview 的坐标空间中，需要转换到按钮自身的坐标系
    NSPoint localPoint = [self convertPoint:point fromView:self.superview];
    NSView* result = NSPointInRect(localPoint, self.bounds) ? self : nil;
    return result;
}

// NSButton with bordered=NO does not automatically fire target/action on click.
// We must handle mouseDown: manually to send the action to the target.
-(void)mouseDown:(NSEvent*)event {
    NSLog(@"[S1RoundedButton] mouseDown: title=%@ action=%@ target=%@", self.title, NSStringFromSelector(self.action), self.target);
    [NSApp sendAction:self.action to:self.target from:self];
}

// Track mouse so mouseDown: is only delivered when inside the button.
- (void)mouseDragged:(NSEvent*)event {
    // consume drag to prevent accidental selection
}

@end
