// permission-settings — 授权分级设置窗口（六类三档）
//
// 用法:
//   permission-settings [--settings <settings.json>] [--ledger <ledger.jsonl>] [--print]
//
// 六行，每行左边是类名与一句话说明，中间三档单选（human / pm / silent），右边标出当前来源：
//   默认 —— 用户没改过，台账里最近一次判定也没有宿主规则参与；
//   用户改过 —— settings.json 的 permissionClasses 里有这一类；
//   跟随宿主 —— 用户没改过，而台账里这一类最近一次判定是宿主规则决定的。
// 点选即写回 settings.json（原子替换），插件每次判定都会重读，不用重启 OpenCode。
// 只写插件自己的设置文件，不碰 opencode.jsonc。
// --print：不开窗口，把当前六行的状态打印成 JSON（用于验收与排查）。

#import <Cocoa/Cocoa.h>

static NSString *gSettingsPath;
static NSString *gLedgerPath;

static NSArray<NSString *> *kTiers;
static NSArray<NSString *> *kTierLabels;
static NSArray<NSDictionary *> *kClasses;

static void initTables(void) {
    kTiers = @[ @"human", @"pm", @"silent" ];
    kTierLabels = @[ @"人工 human", @"案头 pm", @"静默 silent" ];
    kClasses = @[
        @{@"id" : @"1", @"name" : @"不可逆或越界", @"desc" : @"删除、sudo、凭证与密钥、对外发布、项目外写入、判不清归属", @"tier" : @"human"},
        @{@"id" : @"2", @"name" : @"项目外只读", @"desc" : @"读取、搜索项目目录以外的文件", @"tier" : @"pm"},
        @{@"id" : @"3", @"name" : @"项目内执行", @"desc" : @"在项目里跑 shell 命令", @"tier" : @"pm"},
        @{@"id" : @"4", @"name" : @"项目内写入", @"desc" : @"在项目里编辑、写入、新建文件", @"tier" : @"pm"},
        @{@"id" : @"5", @"name" : @"项目内只读", @"desc" : @"读取、搜索项目里的文件", @"tier" : @"silent"},
        @{@"id" : @"6", @"name" : @"无副作用", @"desc" : @"查询、列目录、读配置、联网检索", @"tier" : @"silent"},
    ];
}

static NSString *argValue(NSArray<NSString *> *args, NSString *flag) {
    NSUInteger i = [args indexOfObject:flag];
    if (i == NSNotFound || i + 1 >= args.count) return nil;
    return args[i + 1];
}

// ---------- 文件 ----------

static NSMutableDictionary *readSettings(void) {
    NSData *data = [NSData dataWithContentsOfFile:gSettingsPath];
    if (!data) return [NSMutableDictionary dictionary];
    id obj = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil];
    return [obj isKindOfClass:[NSMutableDictionary class]] ? obj : [NSMutableDictionary dictionary];
}

static NSDictionary *userClasses(void) {
    id raw = readSettings()[@"permissionClasses"];
    if (![raw isKindOfClass:[NSDictionary class]]) return @{};
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    for (NSString *key in raw) {
        id value = raw[key];
        if ([value isKindOfClass:[NSString class]] && [kTiers containsObject:value]) out[key] = value;
    }
    return out;
}

/** 只改 permissionClasses，保留文件里的其他键；写临时文件再改名，插件不会读到半截 */
static BOOL writeClass(NSString *cls, NSString *tier) {
    NSMutableDictionary *settings = readSettings();
    NSMutableDictionary *classes = [settings[@"permissionClasses"] isKindOfClass:[NSDictionary class]]
                                       ? [settings[@"permissionClasses"] mutableCopy]
                                       : [NSMutableDictionary dictionary];
    if (tier) classes[cls] = tier;
    else [classes removeObjectForKey:cls];
    settings[@"permissionClasses"] = classes;
    NSData *data = [NSJSONSerialization dataWithJSONObject:settings
                                                   options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                     error:nil];
    if (!data) return NO;
    [[NSFileManager defaultManager] createDirectoryAtPath:[gSettingsPath stringByDeletingLastPathComponent]
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    NSString *tmp = [gSettingsPath stringByAppendingString:@".tmp"];
    if (![data writeToFile:tmp atomically:NO]) return NO;
    return rename(tmp.fileSystemRepresentation, gSettingsPath.fileSystemRepresentation) == 0;
}

/** 台账末尾每一类最近一次判定（只读最后 1MB） */
static NSDictionary *lastDecisions(void) {
    NSFileHandle *fh = [NSFileHandle fileHandleForReadingAtPath:gLedgerPath];
    if (!fh) return @{};
    unsigned long long size = [fh seekToEndOfFile];
    unsigned long long start = size > 1048576 ? size - 1048576 : 0;
    [fh seekToFileOffset:start];
    NSData *data = [fh readDataToEndOfFile];
    [fh closeFile];
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        if (line.length < 2) continue;
        id row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        if (![row isKindOfClass:[NSDictionary class]]) continue;
        id cls = row[@"class"];
        if ([cls isKindOfClass:[NSString class]]) out[cls] = row;
    }
    return out;
}

/** 一行的状态：选中的档位、来源、说明 */
static NSDictionary *rowState(NSDictionary *cls, NSDictionary *user, NSDictionary *last) {
    NSString *cid = cls[@"id"];
    NSString *explicitTier = user[cid];
    NSDictionary *row = last[cid];
    if (explicitTier) {
        return @{@"class" : cid, @"tier" : explicitTier, @"source" : @"user", @"label" : @"用户改过"};
    }
    if ([row[@"source"] isEqual:@"host"]) {
        NSString *effective = [row[@"tier"] isKindOfClass:[NSString class]] ? row[@"tier"] : @"?";
        NSDictionary *rule = [row[@"host_rule"] isKindOfClass:[NSDictionary class]] ? row[@"host_rule"] : nil;
        NSString *ruleText = rule ? [NSString stringWithFormat:@"%@ %@ %@", rule[@"action"], rule[@"resource"], rule[@"effect"]]
                                  : [NSString stringWithFormat:@"宿主 %@", row[@"host_effect"] ?: @"?"];
        return @{
            @"class" : cid,
            @"tier" : cls[@"tier"],
            @"source" : @"host",
            @"label" : [NSString stringWithFormat:@"跟随宿主 · 最近 %@ → %@", row[@"host_effect"] ?: @"?", effective],
            @"detail" : [NSString stringWithFormat:@"跟随宿主（最近一次：%@ → %@）", ruleText, effective]
        };
    }
    return @{@"class" : cid, @"tier" : cls[@"tier"], @"source" : @"default", @"label" : @"默认"};
}

static NSArray<NSDictionary *> *allStates(void) {
    NSDictionary *user = userClasses();
    NSDictionary *last = lastDecisions();
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *cls in kClasses) [out addObject:rowState(cls, user, last)];
    return out;
}

// ---------- 窗口 ----------

@interface Row : NSObject
@property(nonatomic, copy) NSString *cls;
@property(nonatomic, strong) NSArray<NSButton *> *radios;
@property(nonatomic, strong) NSTextField *source;
@property(nonatomic, strong) NSButton *reset;
@end

@implementation Row
@end

@interface Controller : NSObject <NSWindowDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSMutableArray<Row *> *rows;
@property(nonatomic, strong) NSTextField *status;
@end

static NSTextField *label(NSString *text, CGFloat size, BOOL bold, NSColor *color) {
    NSTextField *field = [NSTextField labelWithString:text];
    field.font = bold ? [NSFont boldSystemFontOfSize:size] : [NSFont systemFontOfSize:size];
    field.textColor = color;
    field.lineBreakMode = NSLineBreakByTruncatingTail;
    return field;
}

@implementation Controller

- (void)build {
    CGFloat width = 920, rowHeight = 58, top = 64, height = top + rowHeight * 6 + 64;
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, width, height)
                                              styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"OpenCode 授权分级";
    self.window.delegate = self;
    [self.window center];
    NSView *content = self.window.contentView;

    NSTextField *h1 = label(@"类", 12, YES, NSColor.secondaryLabelColor);
    h1.frame = NSMakeRect(20, height - 36, 300, 18);
    NSTextField *h2 = label(@"档位", 12, YES, NSColor.secondaryLabelColor);
    h2.frame = NSMakeRect(360, height - 36, 200, 18);
    NSTextField *h3 = label(@"来源", 12, YES, NSColor.secondaryLabelColor);
    h3.frame = NSMakeRect(690, height - 36, 200, 18);
    [content addSubview:h1];
    [content addSubview:h2];
    [content addSubview:h3];

    self.rows = [NSMutableArray array];
    for (NSUInteger i = 0; i < kClasses.count; i++) {
        NSDictionary *cls = kClasses[i];
        CGFloat y = height - top - rowHeight * (i + 1);

        NSBox *line = [[NSBox alloc] initWithFrame:NSMakeRect(20, y + rowHeight - 1, width - 40, 1)];
        line.boxType = NSBoxSeparator;
        [content addSubview:line];

        NSTextField *name = label([NSString stringWithFormat:@"类 %@ · %@", cls[@"id"], cls[@"name"]], 13, YES, NSColor.labelColor);
        name.frame = NSMakeRect(20, y + 28, 330, 18);
        NSTextField *desc = label(cls[@"desc"], 11, NO, NSColor.secondaryLabelColor);
        desc.frame = NSMakeRect(20, y + 10, 330, 16);
        desc.toolTip = cls[@"desc"];
        [content addSubview:name];
        [content addSubview:desc];

        // 每行的三个单选放进同一个容器，系统按容器自动互斥
        NSView *group = [[NSView alloc] initWithFrame:NSMakeRect(360, y + 16, 320, 24)];
        NSMutableArray *radios = [NSMutableArray array];
        for (NSUInteger t = 0; t < kTiers.count; t++) {
            NSButton *radio = [NSButton radioButtonWithTitle:kTierLabels[t] target:self action:@selector(picked:)];
            radio.frame = NSMakeRect(t * 106, 0, 104, 24);
            radio.tag = (NSInteger)(i * 10 + t);
            radio.identifier = [NSString stringWithFormat:@"class%@-%@", cls[@"id"], kTiers[t]];
            [radio setAccessibilityLabel:[NSString stringWithFormat:@"类 %@ %@", cls[@"id"], kTierLabels[t]]];
            [group addSubview:radio];
            [radios addObject:radio];
        }
        [content addSubview:group];

        NSTextField *source = label(@"", 11, NO, NSColor.secondaryLabelColor);
        source.frame = NSMakeRect(690, y + 28, 210, 18);
        [content addSubview:source];

        NSButton *reset = [NSButton buttonWithTitle:@"恢复默认" target:self action:@selector(resetRow:)];
        reset.controlSize = NSControlSizeSmall;
        reset.font = [NSFont systemFontOfSize:11];
        reset.bezelStyle = NSBezelStyleRounded;
        reset.frame = NSMakeRect(686, y + 4, 80, 22);
        reset.tag = (NSInteger)i;
        reset.identifier = [NSString stringWithFormat:@"class%@-reset", cls[@"id"]];
        [content addSubview:reset];

        Row *row = [Row new];
        row.cls = cls[@"id"];
        row.radios = radios;
        row.source = source;
        row.reset = reset;
        [self.rows addObject:row];
    }

    self.status = label(@"", 11, NO, NSColor.tertiaryLabelColor);
    self.status.frame = NSMakeRect(20, 18, width - 40, 32);
    self.status.lineBreakMode = NSLineBreakByWordWrapping;
    self.status.maximumNumberOfLines = 2;
    [content addSubview:self.status];

    [self refresh];
    [NSTimer scheduledTimerWithTimeInterval:2.0 target:self selector:@selector(refresh) userInfo:nil repeats:YES];
}

- (void)refresh {
    NSArray *states = allStates();
    for (NSUInteger i = 0; i < self.rows.count; i++) {
        Row *row = self.rows[i];
        NSDictionary *state = states[i];
        NSUInteger selected = [kTiers indexOfObject:state[@"tier"]];
        for (NSUInteger t = 0; t < row.radios.count; t++) row.radios[t].state = t == selected ? NSControlStateValueOn : NSControlStateValueOff;
        row.source.stringValue = state[@"label"];
        row.source.toolTip = state[@"detail"] ?: state[@"label"];
        row.source.textColor = [state[@"source"] isEqual:@"user"] ? NSColor.systemBlueColor
                               : [state[@"source"] isEqual:@"host"] ? NSColor.systemOrangeColor
                                                                    : NSColor.secondaryLabelColor;
        row.reset.enabled = [state[@"source"] isEqual:@"user"];
    }
    if (self.status.stringValue.length == 0 || ![self.status.stringValue hasPrefix:@"已"]) {
        self.status.stringValue = [NSString stringWithFormat:@"改动即时生效，不用重启 OpenCode。宿主 deny 始终生效。设置文件：%@", gSettingsPath];
    }
}

- (void)picked:(NSButton *)sender {
    NSUInteger i = (NSUInteger)sender.tag / 10, t = (NSUInteger)sender.tag % 10;
    NSString *cls = kClasses[i][@"id"];
    BOOL ok = writeClass(cls, kTiers[t]);
    self.status.stringValue = ok ? [NSString stringWithFormat:@"已保存：类 %@ → %@（%@）", cls, kTiers[t], gSettingsPath]
                                 : [NSString stringWithFormat:@"保存失败：%@", gSettingsPath];
    [self refresh];
}

- (void)resetRow:(NSButton *)sender {
    NSString *cls = kClasses[(NSUInteger)sender.tag][@"id"];
    BOOL ok = writeClass(cls, nil);
    self.status.stringValue = ok ? [NSString stringWithFormat:@"已恢复默认：类 %@ → %@", cls, kClasses[(NSUInteger)sender.tag][@"tier"]]
                                 : [NSString stringWithFormat:@"保存失败：%@", gSettingsPath];
    [self refresh];
}

- (void)windowWillClose:(NSNotification *)notification {
    [NSApp terminate:nil];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        initTables();
        NSArray<NSString *> *args = [[NSProcessInfo processInfo] arguments];
        NSString *base = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/opencode/permission-notify"];
        gSettingsPath = argValue(args, @"--settings") ?: [base stringByAppendingPathComponent:@"settings.json"];
        gLedgerPath = argValue(args, @"--ledger") ?: [base stringByAppendingPathComponent:@"ledger.jsonl"];

        if ([args containsObject:@"--print"]) {
            NSData *data = [NSJSONSerialization dataWithJSONObject:allStates() options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
            printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
            return 0;
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        Controller *controller = [Controller new];
        [controller build];
        [controller.window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        [NSApp run];
    }
    return 0;
}
