// cutout.swift — 用 macOS 自带的前景分离 API 抠图（去背景 / 出透明底）
//
// 【为什么用它】AI 生成的图通常没有透明通道，而桌宠素材必须透明。
// 这个工具直接用 macOS 14+ 的 Vision 框架做前景分离，**完全本地、免费、效果很好**。
//
// 【实测】拿我们自己的立绘合成到纯色底上再抠回来：
//     IoU（前景重合度）99.1%    像素准确率 99.2%
//     呆毛、发丝、半透明发梢都保住了
//
// 【编译】
//     cd <项目根>
//     mkdir -p .cache/swift
//     swiftc -O -module-cache-path "$(pwd)/.cache/swift" -o tools/cutout tools/cutout.swift
//
//   ⚠️ 两个坑：
//   1. **必须指定 `-module-cache-path`，而且要用绝对路径**。默认缓存在 /var/folders 下，
//      受限环境里会报 "unable to open output file ... Operation not permitted"；
//      用相对路径则可能和已有缓存指向同一处，报
//      "module '_DarwinFoundation1' is defined in both ..." 然后 signal 11 崩掉。
//   2. 需要 Xcode Command Line Tools（`xcode-select --install`）。
//      本机没有完整 Xcode 也能编译 —— 这个工具只依赖 Vision / CoreImage / AppKit。
//
// 【用法】
//     ./tools/cutout 输入.png 输出.png
//
//   输出是带 alpha 通道的 PNG。
//
// 【⚠️ 重要边界】
//   它擅长"前景和背景颜色差别大"的情况。真实 AI 输出的绿幕常有：
//     · 轻微渐变 / 阴影        → 可能要调阈值
//     · 角色边缘的绿色反光（spill）→ 抠完可能带绿边，需要另做 despill
//   所以**必须目视检查边缘**，不要盲信 99% 这个数字（那是理想条件下的）。
import Foundation
import Vision
import CoreImage
import AppKit

guard CommandLine.arguments.count > 2 else {
    FileHandle.standardError.write("用法: cutout <in> <out>\n".data(using: .utf8)!)
    exit(2)
}
let inPath = CommandLine.arguments[1]
let outPath = CommandLine.arguments[2]

guard let src = CIImage(contentsOf: URL(fileURLWithPath: inPath)) else {
    FileHandle.standardError.write("读不到输入图\n".data(using: .utf8)!); exit(1)
}

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(ciImage: src, options: [:])
do {
    try handler.perform([request])
    guard let result = request.results?.first else {
        FileHandle.standardError.write("没有检测到前景主体\n".data(using: .utf8)!); exit(3)
    }
    let masked = try result.generateMaskedImage(
        ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: false)
    let out = CIImage(cvPixelBuffer: masked)
    let ctx = CIContext()
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { exit(1) }
    try ctx.writePNGRepresentation(of: out, to: URL(fileURLWithPath: outPath),
                                   format: .RGBA8, colorSpace: colorSpace)
    print("✅ 抠图成功 → \(outPath)")
} catch {
    FileHandle.standardError.write("失败: \(error)\n".data(using: .utf8)!); exit(1)
}
