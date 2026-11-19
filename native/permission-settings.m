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
// 界面中英双语：settings.json 的 uiLanguage（"zh" / "en"）优先，没有就跟随系统首选语言；右下角可切换。
// 只写插件自己的设置文件，不碰 opencode.jsonc。
// --print：不开窗口，把当前六行的状态打印成 JSON（用于验收与排查）。

#import <Cocoa/Cocoa.h>

static NSString *gSettingsPath;
static NSString *gLedgerPath;
/** 当前界面语言："zh" 或 "en"。只管显示；判定、台账、--print 的 label 一律不随它变 */
static NSString *gLang;

static NSArray<NSString *> *kTiers;
static NSArray<NSDictionary *> *kClasses;
static NSDictionary<NSString *, NSDictionary<NSString *, NSString *> *> *kStrings;

static void initTables(void) {
    kTiers = @[ @"human", @"pm", @"silent" ];
    kClasses = @[
        @{@"id" : @"1", @"tier" : @"human"},
        @{@"id" : @"2", @"tier" : @"pm"},
        @{@"id" : @"3", @"tier" : @"pm"},
        @{@"id" : @"4", @"tier" : @"pm"},
        @{@"id" : @"5", @"tier" : @"silent"},
        @{@"id" : @"6", @"tier" : @"silent"},
    ];
    // 界面文案：加一条文案就在这里两种语言各加一行，用 T(@"键") 取
    kStrings = @{
        @"zh" : @{
            @"window.title" : @"OpenCode 授权分级",
            @"header.class" : @"类",
            @"header.tier" : @"档位",
            @"header.source" : @"来源",
            @"class.format" : @"类 %@ · %@",
            @"class1.name" : @"不可逆或越界",
            @"class1.desc" : @"删除、sudo、凭证与密钥、对外发布、项目外写入、判不清归属",
            @"class2.name" : @"项目外只读",
            @"class2.desc" : @"读取、搜索项目目录以外的文件",
            @"class3.name" : @"项目内执行",
            @"class3.desc" : @"在项目里跑 shell 命令",
            @"class4.name" : @"项目内写入",
            @"class4.desc" : @"在项目里编辑、写入、新建文件",
            @"class5.name" : @"项目内只读",
            @"class5.desc" : @"读取、搜索项目里的文件",
            @"class6.name" : @"无副作用",
            @"class6.desc" : @"查询、列目录、读配置、联网检索",
            @"tier.human" : @"人工 human",
            @"tier.pm" : @"案头 pm",
            @"tier.silent" : @"静默 silent",
            @"radio.a11y" : @"类 %@ %@",
            @"source.default" : @"默认",
            @"source.user" : @"用户改过",
            @"source.host" : @"跟随宿主 · 最近 %@ → %@",
            @"source.host.detail" : @"跟随宿主（最近一次：%@ → %@）",
            @"source.host.effect" : @"宿主 %@",
            @"button.reset" : @"恢复默认",
            @"language.system" : @"跟随系统",
            @"language.a11y" : @"界面语言",
            @"status.idle" : @"改动即时生效，不用重启 OpenCode。宿主 deny 始终生效。设置文件：%@",
            @"status.saved" : @"已保存：类 %@ → %@（%@）",
            @"status.reset" : @"已恢复默认：类 %@ → %@",
            @"status.failed" : @"保存失败：%@",
        },
        @"en" : @{
            @"window.title" : @"OpenCode Permission Classes",
            @"header.class" : @"Class",
            @"header.tier" : @"Tier",
            @"header.source" : @"Source",
            @"class.format" : @"Class %@ · %@",
            @"class1.name" : @"Irreversible or out of bounds",
            @"class1.desc" : @"Deletes, sudo, credentials and keys, publishing, writes outside the project, unclear ownership",
            @"class2.name" : @"Read outside the project",
            @"class2.desc" : @"Read and search files outside the project directory",
            @"class3.name" : @"Run in the project",
            @"class3.desc" : @"Run shell commands in the project",
            @"class4.name" : @"Write in the project",
            @"class4.desc" : @"Edit, write and create files in the project",
            @"class5.name" : @"Read in the project",
            @"class5.desc" : @"Read and search files in the project",
            @"class6.name" : @"No side effects",
            @"class6.desc" : @"Queries, directory listings, reading config, web search",
            @"tier.human" : @"Human",
            @"tier.pm" : @"Docket (pm)",
            @"tier.silent" : @"Silent",
            @"radio.a11y" : @"Class %@ %@",
            @"source.default" : @"Default",
            @"source.user" : @"Changed by you",
            @"source.host" : @"Follows host · last %@ → %@",
            @"source.host.detail" : @"Follows host (last decision: %@ → %@)",
            @"source.host.effect" : @"host %@",
            @"button.reset" : @"Reset to default",
            @"language.system" : @"System",
            @"language.a11y" : @"Interface language",
            @"status.idle" : @"Changes apply immediately; no need to restart OpenCode. Host deny always applies. Settings file: %@",
            @"status.saved" : @"Saved: class %@ → %@ (%@)",
            @"status.reset" : @"Reset to default: class %@ → %@",
            @"status.failed" : @"Save failed: %@",
        },
    };
}

static NSString *TL(NSString *lang, NSString *key) {
    return kStrings[lang][key] ?: kStrings[@"en"][key] ?: key;
}

static NSString *T(NSString *key) {
    return TL(gLang, key);
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

/** 改设置文件里的某些键，保留其他键；写临时文件再改名，插件不会读到半截 */
static BOOL writeSettings(void (^mutate)(NSMutableDictionary *settings)) {
    NSMutableDictionary *settings = readSettings();
    mutate(settings);
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

/** 只改 permissionClasses */
static BOOL writeClass(NSString *cls, NSString *tier) {
    return writeSettings(^(NSMutableDictionary *settings) {
        NSMutableDictionary *classes = [settings[@"permissionClasses"] isKindOfClass:[NSDictionary class]]
                                           ? [settings[@"permissionClasses"] mutableCopy]
                                           : [NSMutableDictionary dictionary];
        if (tier) classes[cls] = tier;
        else [classes removeObjectForKey:cls];
        settings[@"permissionClasses"] = classes;
    });
}

// ---------- 语言：settings.json 的 uiLanguage（"zh" / "en"）优先，缺省或不合法时跟随系统首选语言 ----------

static NSString *systemLanguage(void) {
    NSString *first = NSLocale.preferredLanguages.firstObject ?: @"en";
    return [first hasPrefix:@"zh"] ? @"zh" : @"en";
}

static NSString *savedLanguage(void) {
    id value = readSettings()[@"uiLanguage"];
    return [value isEqual:@"zh"] || [value isEqual:@"en"] ? value : nil;
}

/** lang 为 nil 表示删掉 uiLanguage，回到跟随系统 */
static BOOL writeLanguage(NSString *lang) {
    return writeSettings(^(NSMutableDictionary *settings) {
        if (lang) settings[@"uiLanguage"] = lang;
        else [settings removeObjectForKey:@"uiLanguage"];
    });
}

// ---------- 状态 ----------

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

/** 来源标签与悬停说明；host 时 row 是台账里这一类最近一次判定 */
static NSArray<NSString *> *sourceText(NSString *lang, NSString *source, NSDictionary *row) {
    if ([source isEqual:@"user"]) return @[ TL(lang, @"source.user") ];
    if (![source isEqual:@"host"]) return @[ TL(lang, @"source.default") ];
    NSString *effective = [row[@"tier"] isKindOfClass:[NSString class]] ? row[@"tier"] : @"?";
    NSDictionary *rule = [row[@"host_rule"] isKindOfClass:[NSDictionary class]] ? row[@"host_rule"] : nil;
    NSString *ruleText = rule ? [NSString stringWithFormat:@"%@ %@ %@", rule[@"action"], rule[@"resource"], rule[@"effect"]]
                              : [NSString stringWithFormat:TL(lang, @"source.host.effect"), row[@"host_effect"] ?: @"?"];
    return @[
        [NSString stringWithFormat:TL(lang, @"source.host"), row[@"host_effect"] ?: @"?", effective],
        [NSString stringWithFormat:TL(lang, @"source.host.detail"), ruleText, effective]
    ];
}

/**
 * 一行的状态：选中的档位、来源、说明。
 * label / detail 固定中文，--print 的输出不随界面语言变；ui_label / ui_detail 是当前界面语言的版本。
 */
static NSDictionary *rowState(NSDictionary *cls, NSDictionary *user, NSDictionary *last) {
    NSString *cid = cls[@"id"];
    NSString *explicitTier = user[cid];
    NSDictionary *row = last[cid];
    NSString *source = explicitTier ? @"user" : [row[@"source"] isEqual:@"host"] ? @"host" : @"default";
    NSArray *fixed = sourceText(@"zh", source, row);
    NSArray *shown = sourceText(gLang, source, row);
    NSMutableDictionary *out = [@{
        @"class" : cid,
        @"tier" : explicitTier ?: cls[@"tier"],
        @"source" : source,
        @"label" : fixed[0],
        @"ui_label" : shown[0]
    } mutableCopy];
    if (fixed.count > 1) {
        out[@"detail"] = fixed[1];
        out[@"ui_detail"] = shown[1];
    }
    return out;
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
/** 刚保存或保存失败的提示；为 nil 时状态栏显示常驻说明 */
@property(nonatomic, copy) NSString *notice;
@end

static NSTextField *label(NSString *text, CGFloat size, BOOL bold, NSColor *color) {
    NSTextField *field = [NSTextField labelWithString:text];
    field.font = bold ? [NSFont boldSystemFontOfSize:size] : [NSFont systemFontOfSize:size];
    field.textColor = color;
    field.lineBreakMode = NSLineBreakByTruncatingTail;
    return field;
}

/**
 * 设文字并标上界面语言。首选语言里繁体排在简体前面时（如 en-US、zh-Hant-HK、zh-Hans），
 * 不标语言的中文会按繁体习惯把「、。」画在字格正中。先设好 font、textColor、lineBreakMode 再调。
 */
static void setText(NSTextField *field, NSString *text) {
    NSMutableParagraphStyle *paragraph = [NSMutableParagraphStyle new];
    paragraph.lineBreakMode = field.lineBreakMode;
    field.attributedStringValue = [[NSAttributedString alloc] initWithString:text ?: @""
                                                                  attributes:@{
                                                                      NSFontAttributeName : field.font,
                                                                      NSForegroundColorAttributeName : field.textColor,
                                                                      NSParagraphStyleAttributeName : paragraph,
                                                                      (NSString *)kCTLanguageAttributeName : [gLang isEqual:@"zh"] ? @"zh-Hans" : @"en"
                                                                  }];
}

static CGFloat textWidth(NSString *text, NSFont *font) {
    return ceil([text sizeWithAttributes:@{NSFontAttributeName : font}].width);
}

static CGFloat textHeight(NSString *text, NSFont *font, CGFloat width) {
    return ceil([text boundingRectWithSize:NSMakeSize(width, 1000)
                                   options:NSStringDrawingUsesLineFragmentOrigin
                                attributes:@{NSFontAttributeName : font}]
                    .size.height);
}

@implementation Controller

/** 按当前语言量好每一列再排版；切换语言时整窗重排 */
- (void)build {
    NSView *content = self.window.contentView;
    for (NSView *view in [content.subviews copy]) [view removeFromSuperview];
    self.window.title = T(@"window.title");

    NSFont *nameFont = [NSFont boldSystemFontOfSize:13], *small = [NSFont systemFontOfSize:11];
    const CGFloat margin = 20, gap = 24;

    // 第一列：类名不换行；说明按列宽折行，最多两行
    CGFloat nameWidth = 0, descWidth = 0;
    for (NSDictionary *cls in kClasses) {
        NSString *cid = cls[@"id"];
        NSString *name = [NSString stringWithFormat:T(@"class.format"), cid, T([NSString stringWithFormat:@"class%@.name", cid])];
        nameWidth = MAX(nameWidth, textWidth(name, nameFont));
        descWidth = MAX(descWidth, textWidth(T([NSString stringWithFormat:@"class%@.desc", cid]), small));
    }
    CGFloat col1 = MAX(nameWidth, MIN(descWidth, 380)) + 4;
    CGFloat descHeight = 0;
    for (NSDictionary *cls in kClasses) {
        descHeight = MAX(descHeight, textHeight(T([NSString stringWithFormat:@"class%@.desc", cls[@"id"]]), small, col1));
    }
    CGFloat rowHeight = MAX(58, 10 + 18 + 4 + descHeight + 10);

    // 第二列：三个单选按各自宽度依次排开，间距一致
    const CGFloat radioGap = 18;
    NSMutableArray<NSNumber *> *radioX = [NSMutableArray array], *radioW = [NSMutableArray array];
    CGFloat col2 = 0;
    for (NSString *tier in kTiers) {
        NSButton *probe = [NSButton radioButtonWithTitle:T([@"tier." stringByAppendingString:tier]) target:nil action:nil];
        [probe sizeToFit];
        if (col2 > 0) col2 += radioGap;
        [radioX addObject:@(col2)];
        [radioW addObject:@(probe.frame.size.width + 4)];
        col2 += probe.frame.size.width + 4;
    }

    // 第三列：来源标签按可能出现的最长一种量（宿主 allow/ask/deny × 四种档位），恢复默认按钮放在下面
    NSButton *probeReset = [NSButton buttonWithTitle:T(@"button.reset") target:nil action:nil];
    probeReset.controlSize = NSControlSizeSmall;
    probeReset.font = small;
    [probeReset sizeToFit];
    CGFloat resetWidth = probeReset.frame.size.width + 12;
    CGFloat sourceWidth = MAX(textWidth(T(@"source.user"), small), textWidth(T(@"source.default"), small));
    for (NSString *effect in @[ @"allow", @"ask", @"deny" ]) {
        for (NSString *tier in @[ @"human", @"pm", @"silent", @"deny" ]) {
            sourceWidth = MAX(sourceWidth, textWidth([NSString stringWithFormat:T(@"source.host"), effect, tier], small));
        }
    }
    CGFloat col3 = MAX(sourceWidth + 8, resetWidth);

    CGFloat x1 = margin, x2 = x1 + col1 + gap, x3 = x2 + col2 + gap;
    CGFloat width = x3 + col3 + margin;

    // 底栏：左边状态说明（最多三行），右边语言切换
    NSSegmentedControl *language = [NSSegmentedControl segmentedControlWithLabels:@[ T(@"language.system"), @"中文", @"English" ]
                                                                     trackingMode:NSSegmentSwitchTrackingSelectOne
                                                                           target:self
                                                                           action:@selector(languagePicked:)];
    language.controlSize = NSControlSizeSmall;
    language.font = small;
    [language sizeToFit];
    language.identifier = @"language";
    [language setAccessibilityLabel:T(@"language.a11y")];
    NSString *saved = savedLanguage();
    language.selectedSegment = saved == nil ? 0 : [saved isEqual:@"zh"] ? 1 : 2;
    CGFloat statusWidth = width - margin * 2 - language.frame.size.width - gap;
    CGFloat statusHeight = MIN(textHeight([NSString stringWithFormat:T(@"status.idle"), gSettingsPath], small, statusWidth), 3 * 15);
    CGFloat bottom = MAX(64, statusHeight + 32);

    CGFloat top = 64, height = top + rowHeight * kClasses.count + bottom;
    NSRect frame = self.window.frame;
    NSRect next = [self.window frameRectForContentRect:NSMakeRect(0, 0, width, height)];
    next.origin = NSMakePoint(frame.origin.x, NSMaxY(frame) - next.size.height);   // 左上角不动
    [self.window setFrame:next display:YES];

    NSArray *headers = @[ @[ T(@"header.class"), @(x1), @(col1) ], @[ T(@"header.tier"), @(x2), @(col2) ], @[ T(@"header.source"), @(x3), @(col3) ] ];
    for (NSArray *h in headers) {
        NSTextField *field = label(@"", 12, YES, NSColor.secondaryLabelColor);
        setText(field, h[0]);
        field.frame = NSMakeRect([h[1] doubleValue], height - 36, [h[2] doubleValue], 18);
        [content addSubview:field];
    }

    self.rows = [NSMutableArray array];
    for (NSUInteger i = 0; i < kClasses.count; i++) {
        NSDictionary *cls = kClasses[i];
        NSString *cid = cls[@"id"];
        CGFloat y = height - top - rowHeight * (i + 1);
        CGFloat mid = y + rowHeight / 2;

        NSBox *line = [[NSBox alloc] initWithFrame:NSMakeRect(margin, y + rowHeight - 1, width - margin * 2, 1)];
        line.boxType = NSBoxSeparator;
        [content addSubview:line];

        NSString *nameText = [NSString stringWithFormat:T(@"class.format"), cid, T([NSString stringWithFormat:@"class%@.name", cid])];
        NSTextField *name = label(@"", 13, YES, NSColor.labelColor);
        setText(name, nameText);
        name.frame = NSMakeRect(x1, y + rowHeight - 10 - 18, col1, 18);
        NSString *descText = T([NSString stringWithFormat:@"class%@.desc", cid]);
        NSTextField *desc = [NSTextField wrappingLabelWithString:@""];
        desc.font = small;
        desc.textColor = NSColor.secondaryLabelColor;
        desc.maximumNumberOfLines = 2;
        setText(desc, descText);
        desc.frame = NSMakeRect(x1, y + rowHeight - 10 - 18 - 4 - descHeight, col1, descHeight);
        desc.toolTip = descText;
        [content addSubview:name];
        [content addSubview:desc];

        // 每行的三个单选放进同一个容器，系统按容器自动互斥
        NSView *group = [[NSView alloc] initWithFrame:NSMakeRect(x2, mid - 12, col2, 24)];
        NSMutableArray *radios = [NSMutableArray array];
        for (NSUInteger t = 0; t < kTiers.count; t++) {
            NSString *tierLabel = T([@"tier." stringByAppendingString:kTiers[t]]);
            NSButton *radio = [NSButton radioButtonWithTitle:tierLabel target:self action:@selector(picked:)];
            radio.frame = NSMakeRect(radioX[t].doubleValue, 0, radioW[t].doubleValue, 24);
            radio.tag = (NSInteger)(i * 10 + t);
            radio.identifier = [NSString stringWithFormat:@"class%@-%@", cid, kTiers[t]];
            [radio setAccessibilityLabel:[NSString stringWithFormat:T(@"radio.a11y"), cid, tierLabel]];
            [group addSubview:radio];
            [radios addObject:radio];
        }
        [content addSubview:group];

        NSTextField *source = label(@"", 11, NO, NSColor.secondaryLabelColor);
        source.frame = NSMakeRect(x3, mid + 3, col3, 16);
        [content addSubview:source];

        NSButton *reset = [NSButton buttonWithTitle:T(@"button.reset") target:self action:@selector(resetRow:)];
        reset.controlSize = NSControlSizeSmall;
        reset.font = small;
        reset.bezelStyle = NSBezelStyleRounded;
        reset.frame = NSMakeRect(x3 - 4, mid - 22, resetWidth, 22);
        reset.tag = (NSInteger)i;
        reset.identifier = [NSString stringWithFormat:@"class%@-reset", cid];
        [content addSubview:reset];

        Row *row = [Row new];
        row.cls = cid;
        row.radios = radios;
        row.source = source;
        row.reset = reset;
        [self.rows addObject:row];
    }

    self.status = [NSTextField wrappingLabelWithString:@""];
    self.status.font = small;
    self.status.textColor = NSColor.tertiaryLabelColor;
    self.status.maximumNumberOfLines = 3;
    self.status.frame = NSMakeRect(margin, (bottom - statusHeight) / 2, statusWidth, statusHeight);
    [content addSubview:self.status];

    NSSize segment = language.frame.size;
    language.frame = NSMakeRect(width - margin - segment.width, (bottom - segment.height) / 2, segment.width, segment.height);
    [content addSubview:language];

    [self refresh];
}

- (void)refresh {
    NSArray *states = allStates();
    for (NSUInteger i = 0; i < self.rows.count; i++) {
        Row *row = self.rows[i];
        NSDictionary *state = states[i];
        NSUInteger selected = [kTiers indexOfObject:state[@"tier"]];
        for (NSUInteger t = 0; t < row.radios.count; t++) row.radios[t].state = t == selected ? NSControlStateValueOn : NSControlStateValueOff;
        row.source.textColor = [state[@"source"] isEqual:@"user"] ? NSColor.systemBlueColor
                               : [state[@"source"] isEqual:@"host"] ? NSColor.systemOrangeColor
                                                                    : NSColor.secondaryLabelColor;
        setText(row.source, state[@"ui_label"]);
        row.source.toolTip = state[@"ui_detail"] ?: state[@"ui_label"];
        row.reset.enabled = [state[@"source"] isEqual:@"user"];
    }
    setText(self.status, self.notice ?: [NSString stringWithFormat:T(@"status.idle"), gSettingsPath]);
}

- (void)picked:(NSButton *)sender {
    NSUInteger i = (NSUInteger)sender.tag / 10, t = (NSUInteger)sender.tag % 10;
    NSString *cls = kClasses[i][@"id"];
    BOOL ok = writeClass(cls, kTiers[t]);
    self.notice = ok ? [NSString stringWithFormat:T(@"status.saved"), cls, kTiers[t], gSettingsPath]
                     : [NSString stringWithFormat:T(@"status.failed"), gSettingsPath];
    [self refresh];
}

- (void)resetRow:(NSButton *)sender {
    NSString *cls = kClasses[(NSUInteger)sender.tag][@"id"];
    BOOL ok = writeClass(cls, nil);
    self.notice = ok ? [NSString stringWithFormat:T(@"status.reset"), cls, kClasses[(NSUInteger)sender.tag][@"tier"]]
                     : [NSString stringWithFormat:T(@"status.failed"), gSettingsPath];
    [self refresh];
}

- (void)languagePicked:(NSSegmentedControl *)sender {
    NSString *lang = sender.selectedSegment == 1 ? @"zh" : sender.selectedSegment == 2 ? @"en" : nil;
    BOOL ok = writeLanguage(lang);
    gLang = lang ?: systemLanguage();
    self.notice = ok ? nil : [NSString stringWithFormat:T(@"status.failed"), gSettingsPath];
    [self build];
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
        gLang = savedLanguage() ?: systemLanguage();

        if ([args containsObject:@"--print"]) {
            NSData *data = [NSJSONSerialization dataWithJSONObject:allStates() options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
            printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
            return 0;
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        Controller *controller = [Controller new];
        controller.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 900, 500)
                                                        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                                          backing:NSBackingStoreBuffered
                                                            defer:NO];
        controller.window.delegate = controller;
        [controller.window center];
        [controller build];
        [controller.window center];
        [controller.window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        [NSTimer scheduledTimerWithTimeInterval:2.0 target:controller selector:@selector(refresh) userInfo:nil repeats:YES];
        [NSApp run];
    }
    return 0;
}
