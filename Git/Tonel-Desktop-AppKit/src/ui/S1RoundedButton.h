// S1RoundedButton.h — Custom NSButton subclass with drawRect-based rounded background.
// Avoids the CALayer/wantsLayer hit-testing bug where bordered=NO + wantsLayer
// causes clicks to pass through the button.
#pragma once
#import <AppKit/AppKit.h>

@interface S1RoundedButton : NSButton
@property (nonatomic, strong) NSColor* fillColor;
@end
