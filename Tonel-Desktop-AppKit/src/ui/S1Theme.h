// S1Theme.h — Shared colors and constants to eliminate duplication across view controllers
#pragma once
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

static NSColor* S1ThemeBG()                { return [NSColor colorWithRed:19/255.0 green:18/255.0 blue:18/255.0 alpha:1.0]; }
static NSColor* S1ThemeCardBG()            { return [NSColor colorWithRed:30/255.0 green:30/255.0 blue:30/255.0 alpha:1.0]; }
static NSColor* S1ThemeTextPrimary()       { return [NSColor whiteColor]; }
static NSColor* S1ThemeTextMuted()         { return [NSColor colorWithWhite:0.50 alpha:1.0]; }
static NSColor* S1ThemeAccentGreen()       { return [NSColor colorWithRed:52/255.0 green:211/255.0 blue:153/255.0 alpha:1.0]; }
static NSColor* S1ThemeAccentRed()         { return [NSColor colorWithRed:239/255.0 green:68/255.0 blue:68/255.0 alpha:1.0]; }
static NSColor* S1ThemeAccentBlue()        { return [NSColor colorWithRed:99/255.0 green:102/255.0 blue:241/255.0 alpha:1.0]; }
static NSColor* S1ThemeAccentYellow()      { return [NSColor colorWithRed:250/255.0 green:204/255.0 blue:21/255.0 alpha:1.0]; }
static NSColor* S1ThemeFieldBG()           { return [NSColor colorWithRed:45/255.0 green:45/255.0 blue:50/255.0 alpha:1.0]; }

// Aliases used by dialog view controllers
static inline NSColor* CardS1ThemeBG()  { return S1ThemeCardBG(); }
static inline NSColor* FieldS1ThemeBG() { return S1ThemeFieldBG(); }
static NSColor* S1ThemeTopBarBG()          { return [NSColor colorWithWhite:0.10 alpha:1.0]; }

// Window and layout constants
static CGFloat S1ThemeWindowWidth  = 1024.0;
static CGFloat S1ThemeWindowHeight = 768.0;
static CGFloat S1ThemeMinWidth     = 800.0;
static CGFloat S1ThemeMinHeight    = 600.0;
static CGFloat S1ThemeCardWidth    = 440.0;
static CGFloat S1ThemeSettingsCardWidth = 520.0;

NS_ASSUME_NONNULL_END
