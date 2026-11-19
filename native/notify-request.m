// notify-request — macOS 右上角非抢焦浮窗，带按钮的授权请求
//
// 用法:
//   notify-request --title "标题" --message "正文" \
//                  --buttons "允许一次|总是允许|拒绝" \
//                  [--timeout 300] [--slot 0] \
//                  [--skip-if-frontmost ai.opencode.desktop]
//
// 输出（stdout）：被点击的按钮索引 0/1/2；取消或超时 -1；前台已是目标 App 则 -2。
//
// 设计：用 NSWindowStyleMaskNonactivatingPanel 的浮窗放在屏幕右上角，
// 点击按钮不会激活本进程、也不会把 OpenCode 顶到前台，因此不打断当前上下文。

#import <Cocoa/Cocoa.h>

static int gResponse = -1;
static NSWindow *gPanel = nil;
static BOOL gFinished = NO;

static NSString *argValue(NSArray<NSString *> *args, NSString *flag) {
    NSUInteger i = [args indexOfObject:flag];
    if (i == NSNotFound || i + 1 >= args.count) return nil;
    return args[i + 1];
}

static void finish(int response) {
    if (gFinished) return;
    gFinished = YES;
    gResponse = response;
    [gPanel orderOut:nil];
    [NSApp stop:nil];
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                        location:NSZeroPoint
                                   modifierFlags:0
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                         subtype:0
                                           data1:0
                                           data2:0];
    [NSApp postEvent:event atStart:YES];
}

@interface ActionTarget : NSObject
@property(nonatomic) int index;
@end

@implementation ActionTarget
- (void)clicked:(id)sender {
    finish(self.index);
}
@end

// 非激活浮窗里第一次点击会被用来"激活窗口"，这里放行，保证一点就生效
@interface ClickButton : NSButton
@end

@implementation ClickButton
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    return YES;
}
@end

static NSMutableArray *gTargets = nil;

// 不抢焦点：窗口永远不成为 key/main，按钮靠 acceptsFirstMouse 接收点击
@interface ToastWindow : NSWindow
@end

@implementation ToastWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

static NSButton *makeButton(NSString *title, int index) {
    if (!gTargets) gTargets = [NSMutableArray array];
    ActionTarget *own = [ActionTarget new];
    own.index = index;
    [gTargets addObject:own];   // NSButton 的 target 是弱引用，必须自己保住
    NSButton *button = [ClickButton buttonWithTitle:title target:own action:@selector(clicked:)];
    button.bezelStyle = NSBezelStyleRounded;
    button.controlSize = NSControlSizeSmall;
    button.font = [NSFont systemFontOfSize:11.5];
    return button;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 1; i < argc; i++) [args addObject:[NSString stringWithUTF8String:argv[i]]];

        NSString *title = argValue(args, @"--title") ?: @"OpenCode 需要授权";
        NSString *message = argValue(args, @"--message") ?: @"";
        NSString *buttonsSpec = argValue(args, @"--buttons") ?: @"允许一次|总是允许|拒绝";
        NSString *skipIfFrontmost = argValue(args, @"--skip-if-frontmost");
        double timeout = [argValue(args, @"--timeout") doubleValue] ?: 300;
        int slot = [argValue(args, @"--slot") intValue];

        if (skipIfFrontmost.length) {
            NSString *front = NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier;
            if (front && [front isEqualToString:skipIfFrontmost]) {
                printf("-2\n");
                return 0;
            }
        }

        NSArray<NSString *> *buttons = [buttonsSpec componentsSeparatedByString:@"|"];

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        CGFloat width = 360;
        CGFloat padding = 14;
        CGFloat contentWidth = width - padding * 2;

        NSTextField *titleLabel = [NSTextField labelWithString:title];
        titleLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
        titleLabel.textColor = [NSColor labelColor];
        titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
        titleLabel.frame = NSMakeRect(padding, 0, contentWidth, 18);

        // 正文一行对一行：每行（命令或路径）不折行、超宽在中间截断，最多四行，中英文都一样高
        NSArray<NSString *> *bodyLines = [message componentsSeparatedByString:@"\n"];
        if (bodyLines.count > 4) bodyLines = [bodyLines subarrayWithRange:NSMakeRange(0, 4)];
        NSString *body = [bodyLines componentsJoinedByString:@"\n"];
        NSFont *bodyFont = [NSFont systemFontOfSize:11.5];
        NSMutableParagraphStyle *paragraph = [NSMutableParagraphStyle new];
        paragraph.lineBreakMode = NSLineBreakByTruncatingMiddle;
        NSTextField *bodyLabel = [NSTextField labelWithAttributedString:
            [[NSAttributedString alloc] initWithString:body
                                            attributes:@{ NSFontAttributeName: bodyFont,
                                                          NSForegroundColorAttributeName: [NSColor secondaryLabelColor],
                                                          NSParagraphStyleAttributeName: paragraph }]];
        bodyLabel.maximumNumberOfLines = 4;
        bodyLabel.toolTip = body;
        CGFloat bodyHeight = MAX(ceil([bodyLabel.cell cellSizeForBounds:NSMakeRect(0, 0, contentWidth, 1000)].height), 16);

        CGFloat buttonHeight = 24;
        CGFloat height = padding + 18 + 6 + bodyHeight + 10 + buttonHeight + padding;

        NSRect screen = NSScreen.mainScreen.visibleFrame;
        CGFloat originX = NSMaxX(screen) - width - 14;
        CGFloat originY = NSMaxY(screen) - height - 14 - slot * 118;
        if (originY < NSMinY(screen) + 20) originY = NSMinY(screen) + 20;

        NSWindow *panel = [[ToastWindow alloc] initWithContentRect:NSMakeRect(originX, originY, width, height)
                                                      styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                        backing:NSBackingStoreBuffered
                                                          defer:NO];
        gPanel = panel;
        panel.level = NSStatusWindowLevel;
        panel.opaque = NO;
        panel.backgroundColor = [NSColor clearColor];
        panel.hasShadow = YES;
        panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorStationary |
                                   NSWindowCollectionBehaviorFullScreenAuxiliary;
        panel.releasedWhenClosed = NO;

        NSVisualEffectView *effect = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
        effect.material = NSVisualEffectMaterialHUDWindow;
        effect.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        effect.state = NSVisualEffectStateActive;
        effect.wantsLayer = YES;
        effect.layer.cornerRadius = 12;
        effect.layer.masksToBounds = YES;
        panel.contentView = effect;

        CGFloat y = height - padding - 18;
        titleLabel.frame = NSMakeRect(padding, y, contentWidth, 18);
        [effect addSubview:titleLabel];

        y -= 6 + bodyHeight;
        bodyLabel.frame = NSMakeRect(padding, y, contentWidth, bodyHeight);
        [effect addSubview:bodyLabel];

        // 按钮从右往左排
        CGFloat buttonX = width - padding;
        NSInteger shown = MIN((NSInteger)buttons.count, 3);
        for (NSInteger i = shown - 1; i >= 0; i--) {
            NSButton *button = makeButton(buttons[i], (int)i);
            [button sizeToFit];
            CGFloat buttonWidth = MAX(button.frame.size.width + 16, 54);
            buttonX -= buttonWidth;
            button.frame = NSMakeRect(buttonX, padding, buttonWidth, buttonHeight);
            [effect addSubview:button];
            buttonX -= 8;
        }

        [panel orderFrontRegardless];

        if (timeout > 0) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{
                finish(-1);
            });
        }

        [NSApp run];

        printf("%d\n", gResponse);
        fflush(stdout);
    }
    return 0;
}
